## Context

The VSCode extension authenticates to the backend with a `dvf_` API token stored in `vscode.SecretStorage` ([authService.ts](../../../devFlowExtension/src/services/authService.ts)). Today the only way a user obtains that token is to be a JWT-authenticated caller of `POST /api/v1/auth/tokens` — but the frontend has no UI to do that, and the extension's Sign In command simply prompts the user to paste a token they don't have. Once [integrate-frontend-auth](../integrate-frontend-auth/proposal.md) lands, browser-side users will have a real JWT cookie session against the backend. This change uses that session as the trust anchor: the extension generates a pairing handle, opens the browser, and the logged-in user clicks Approve.

The pattern is OAuth 2.0 Device Authorization Grant (RFC 8628), simplified for an internal app: no client_id registry, no scopes (the issued token has the same blanket access any `dvf_` token has today), and no separate "device_code/user_code" split — we use one short, readable `user_code` displayed both in the URL and on the approval page so the user can visually confirm it matches what VSCode showed them.

## Goals / Non-Goals

**Goals:**
- A logged-in browser user can authorize the extension in one click, with no copy-paste.
- The extension never sees the user's password or JWT; it only ever sees a `dvf_` token (same security boundary as today).
- The resulting token flows through the existing `verifyToken` middleware unchanged — no new auth paths to maintain.
- A user on a headless machine (SSH, restricted container) can still sign in by pasting a token they minted elsewhere — the old flow becomes a labeled fallback rather than the default.
- Pairing codes are unguessable in a 10-minute window even under aggressive polling.

**Non-Goals:**
- Per-machine fingerprinting or device naming chosen by the user (the token is auto-named `VSCode (paired YYYY-MM-DD)`; renaming is left to the existing `/auth/tokens` endpoints).
- Refresh tokens or rotation — the issued `dvf_` token has the same lifetime semantics as any other `dvf_` token (lives until revoked).
- Token revocation UI inside the extension — the existing frontend tokens page (planned separately) will handle that.
- OAuth flows for third-party clients. This is a first-party flow for our own extension only.
- Replacing the `dvf_` token format with JWTs in the extension. The extension keeps using bearer tokens against the existing telemetry endpoints.

## Decisions

### 1. Device-code pairing over localhost-callback OAuth

Two flows we considered:

- **Device-code (chosen).** Extension shows/opens a code, browser approves, extension polls. No callback URL, no listener.
- **Localhost callback.** Extension opens a tiny HTTP server on `127.0.0.1:<random-port>`, opens browser with `redirect_uri=http://127.0.0.1:<port>/cb`, frontend redirects to it with the token in the URL fragment.

We chose device-code because:
- **No firewall prompts.** Spinning up a listener on macOS/Windows triggers the OS firewall dialog the first time, which is a confusing onboarding moment.
- **Works in restricted dev environments.** Codespaces, remote containers, and SSH'd sessions cannot bind a local port that the user's browser can reach. Device-code works there with no changes (the user just opens the URL on whatever machine has a browser and the matching login session).
- **No CORS surface to add.** Localhost callbacks would require the frontend to allow redirects to `http://127.0.0.1:*`, which is a CORS/CSP irritation; device-code keeps every request same-origin or extension→backend.
- **Trade-off**: device-code requires polling, which is more requests than a single callback. We accept the cost — at 2-second intervals over a 10-minute TTL, worst case is 300 requests per pairing, and the endpoint is rate-limited and unauthenticated only for the polling path (which only knows an opaque `pairing_id`).

### 2. Two identifiers: `user_code` (human) and `pairing_id` (machine)

The pairing row has two distinct keys:
- **`user_code`** — 8 readable chars (alphabet `BCDFGHJKMNPQRSTVWXZ23456789`, no vowels to avoid words, no ambiguous `0/O/1/I/l`), formatted `XXXX-XXXX`. This is what the user sees in the URL (`/extension/pair?code=BRWN-4F2X`) and on the approval page. The approve endpoint is keyed on it because it's what the browser knows.
- **`pairing_id`** — UUID v4. The extension uses this for polling. It is **never sent to the browser**, so a user who shares their screen reading out the `user_code` does not give an attacker the ability to also poll for the resulting token.

Without this split, an attacker who shoulder-surfs the URL bar could race the legitimate extension to the exchange endpoint. With the split, even knowing the `user_code` lets you only approve a pairing, not collect its token — and you cannot approve a pairing without your own JWT session.

### 3. `dvf_` token returned exactly once via exchange, then row is deleted

After the user approves, the row holds the `api_token_id` (not the plaintext — the plaintext lives only in the response). The extension polls and the response transitions:
- `pending` → row exists, `status = pending`
- `approved` → row exists, `status = approved`, response carries the plaintext token (constructed by re-issuing? no — see below), and the row is updated to `status = consumed` in the same transaction
- `consumed` → second poller gets this and nothing else

We store the plaintext on the row **only between approval and the first successful exchange poll**, encrypted at rest by the existing database disk encryption layer. We chose this over the obvious alternative (mint the token at exchange time, not at approve time) for one reason: the approve action is the moment the user grants authority. If we deferred minting to exchange, a clever attacker who intercepted the `pairing_id` could exchange first and the legitimate extension would silently get a stale "consumed" response with no signal that something was wrong. By minting at approval and transmitting at exchange, the legitimate extension that initiated the pairing is overwhelmingly likely to be the one polling, and the audit trail (`api_tokens.created_at`, `pairing_codes.consumed_at`) is unambiguous.

Trade-off: the plaintext token lives at-rest in `pairing_codes.token_plaintext` for at most a few seconds (until the extension's next poll). We accept this because (a) the column is dropped after exchange, (b) any DB compromise that reads this column already has access to user data far worse than one extension token, and (c) the alternative (re-minting at exchange time) creates the racing-attacker scenario above.

### 4. Polling cadence and backoff

Extension polls every 2 seconds while the user approves. On any non-200, non-202 response (network blip, 5xx), the extension does exponential backoff (2s → 4s → 8s → 16s, cap 30s) until a clean response resumes. On 410 Gone (expired), the extension stops and surfaces an error. The user-visible progress notification has a Cancel action that aborts the loop and deletes the pairing row via a no-op (let it expire on its own — no DELETE endpoint, to keep the surface small).

### 5. Rate limiting

The exchange endpoint is unauthenticated, so we apply a per-`pairing_id` rate limit: 1 request per second (i.e., a single misbehaving extension cannot DoS the server). Implementation: in-memory `Map<pairing_id, last_request_ts>` — pairings expire in 10 minutes so the map is bounded. Going to Redis is not justified at the current scale.

### 6. Keep the paste-token fallback exactly as it is

The new flow becomes `DevVital AI: Sign In`. The old paste-token UX moves to a separate command, `DevVital AI: Sign In with Token`, with no functional changes — it calls the same `auth.setToken()`. This keeps escape hatches working for SSH/restricted environments and means if the pairing infra has an outage, every user has a known-working alternative one command away.

## Risks / Trade-offs

- **[Risk] User shoulder-surfs the `user_code` and an attacker races to approve.** → Mitigated: the attacker would need their own JWT session to call the approve endpoint; the token is then bound to *their* user, not the victim's, so they only authorize their own extension. The actual `dvf_` token never traverses a path the attacker can reach without `pairing_id`.
- **[Risk] User approves the wrong pairing (two browser tabs open, picks the wrong one).** → Mitigated: the approval page shows the `user_code` prominently and the extension's progress notification displays the same code, so the user can visually verify before clicking Approve.
- **[Risk] Polling load if hundreds of users pair simultaneously.** → Bounded: 2s polling × 10-minute TTL × N users = at most N×300 requests per pairing window. Each request is a single indexed lookup. At expected scale (low hundreds of devs) this is well under a single Postgres connection's headroom.
- **[Risk] `pairing_codes.token_plaintext` lives in the DB briefly.** → Accepted; see decision (3). Defense in depth: the column is `NULL`-able and is set to `NULL` in the same transaction that responds with the token, so a crash mid-exchange does not leave plaintext behind for longer than `expires_at`.
- **[Risk] User clicks Approve while not logged in to the frontend** → The `ProtectedRoute` from [integrate-frontend-auth](../integrate-frontend-auth/proposal.md) sends them through `/login` first and brings them back; if that change has not yet landed, the Approve button calls `/api/v1/auth/me` first and shows "Log in to the dashboard first" with a link.
- **[Trade-off] Polling vs. websockets.** Websockets would feel snappier but require additional infrastructure (sticky sessions, heartbeats, the existing Express app doesn't have an upgrade handler). The user-perceived delay between Approve click and extension success is at most one poll interval (~2s), which is acceptable for a once-per-machine action.
- **[Trade-off] We do not present a QR code.** A QR code would help when the user's editor machine has no browser at all (real SSH). The paste-token fallback covers that case, and adding QR rendering means a dependency the extension does not have. Reconsider if user feedback shows demand.

## Migration Plan

This is additive: no existing endpoint or token semantics change.

1. **Backend deploy first.** Ship the three new endpoints + migration. The `pairing_codes` table is created empty. Existing extensions on old versions are unaffected (they never call the new endpoints).
2. **Frontend deploy second.** Ship the `/extension/pair` page. Without an extension calling `POST /pairings` the page is reachable but useless — that's fine.
3. **Extension publish last.** New version replaces the `signIn` command body and adds the `signInWithToken` command. Existing users on the old version continue to use the paste-token flow; nothing breaks. Auto-update brings everyone onto the new flow at their own pace.
4. **Rollback.** Revert the extension publish (users on the new version fall back to paste-token via the `signInWithToken` command). Backend endpoints can stay deployed indefinitely with no harm; if needed, route the three pairing routes to a 404 middleware. The migration is a single `CREATE TABLE` — a `DROP TABLE` rollback is safe because the table only ever holds short-lived data and is self-pruning.

## Open Questions

- **Should the approval page show what permissions the extension will have?** Today every `dvf_` token has identical (full-user) authority, so there is nothing meaningful to display. If we introduce scopes later, this page is the right place to show them.
- **Do we want an audit log entry for each pairing approval?** Probably yes for traceability, but a simple `logger.info({ event: 'pairing_approved', user_id, api_token_id })` covers it without a new table. Decided: do it inline, no new infra.
- **Naming convention for the auto-named token.** Currently `VSCode (paired YYYY-MM-DD)`. If a user pairs the same machine twice in one day they get two tokens with identical names — that is acceptable (they are distinguishable by `id` and `created_at` in the listing). Adding a hostname or random suffix is more privacy leakage than it is worth.
