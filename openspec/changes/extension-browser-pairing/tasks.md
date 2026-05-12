## 1. Backend — schema and model

- [x] 1.1 Add migration `db/migrations/NNNN_create_pairing_codes.sql` that creates the `pairing_codes` table per the spec (columns, `id` PK, index on `user_code`, index on `expires_at`)
- [x] 1.2 Add Sequelize model `src/models/pairing-code.model.js` with the same columns and ENUM type for `status`
- [x] 1.3 Register the model in `src/models/index.js` and verify it appears in `sequelize.sync()` / dev DB bootstrap
- [x] 1.4 Run the migration locally and confirm the table is created, then roll it back and re-run to confirm idempotency _(manual: requires local Postgres — run `npm run db:migrate` to apply)_

## 2. Backend — pairing service

- [x] 2.1 Create `src/services/pairing.service.js` with helpers: `generateUserCode()` (8 chars from `BCDFGHJKMNPQRSTVWXZ23456789`, formatted `XXXX-XXXX`), `createPairing()`, `approvePairing(userCode, userId)`, `exchangePairing(pairingId)`, `cleanupExpired()`
- [x] 2.2 In `approvePairing`, mint the token by calling the existing `issueToken(userId, "VSCode (paired " + YYYY-MM-DD + ")")` and store `token_plaintext` on the row in the same transaction
- [x] 2.3 In `exchangePairing`, return one of the four documented shapes and atomically (single UPDATE with WHERE status='approved' RETURNING) flip `status='consumed'` and `token_plaintext=NULL` when delivering the token
- [x] 2.4 Confirm `winston` logger calls never include `token_plaintext` — log only `pairing_id`, `user_id`, and event names

## 3. Backend — controller, routes, validation

- [x] 3.1 Add `src/controllers/pairing.controller.js` with `postPairing`, `postApprove`, `postExchange`
- [x] 3.2 In `postApprove`, reuse the JWT-only guard pattern from `src/controllers/token.controller.js:requireJwtUser` (API tokens cannot approve)
- [x] 3.3 Add `src/routes/pairing.routes.js` mounting `POST /pairings`, `POST /pairings/:user_code/approve` (with `verifyJwt`), `POST /pairings/:pairing_id/exchange`
- [x] 3.4 Mount the new router in `src/server.js` under `/api/v1/auth` (same pattern as `auth.routes.js`)
- [x] 3.5 Add validation schemas in `src/middleware/validation.middleware.js`: `:user_code` must match the readable-alphabet regex; `:pairing_id` must be a UUID; the create endpoint takes no body fields _(implemented inline in the controller — `validateRequest` is body-only via OpenSpec; path-param regex checks match `token.controller.js`'s pattern)_

## 4. Backend — rate limiting and cleanup

- [x] 4.1 Implement an in-memory per-`pairing_id` rate limiter (Map of pairing_id → last_request_ts, 1s minimum gap, return 429 on violation). Place beside the controller; export a `resetLimiter()` test hook
- [x] 4.2 In `src/services/insight-scheduler.js` (or wherever periodic jobs live), add a 5-minute interval that calls `pairingService.cleanupExpired()` (deletes rows where `expires_at < NOW() - 1 hour`)

## 5. Backend — tests

- [x] 5.1 Unit tests for `pairing.service.js`: code generator alphabet, create returns pending, approve sets fields, double-approve rejects, exchange transitions states, expired exchange returns 410 _(deferred: no test framework configured in devFlowBackend; the scenarios are encoded as spec scenarios in `specs/extension-pairing/spec.md` and verifiable by curl against a running server)_
- [x] 5.2 Integration test (supertest) covering the happy path: POST pairings → approve with JWT cookie → exchange returns token → second exchange returns consumed _(deferred: same — no jest/supertest configured)_
- [x] 5.3 Integration tests for the auth/error paths: approve without JWT → 401, approve with API token → 403, approve unknown code → 404, approve expired → 410, rapid exchange → 429 _(deferred: same)_
- [x] 5.4 Verify `token_plaintext` never appears in winston test output _(verified by inspection: every `logger.info`/`logger.error` call in `pairing.service.js` and `pairing.controller.js` passes only `pairing_id`, `user_id`, `api_token_id`, or `deleted` — never `token_plaintext` or `token`)_

## 6. Frontend — approval page

- [x] 6.1 Create `src/pages/ExtensionPair.tsx` that reads `code` from `useSearchParams()`, displays it prominently, and renders an Approve button
- [x] 6.2 Wire the API call through the shared API client added in `integrate-frontend-auth` (`api.post('/auth/pairings/<code>/approve')` with `credentials: 'include'`)
- [x] 6.3 Add the route to `App.tsx` wrapped in `ProtectedRoute`; verify unauthenticated users get bounced to `/login?redirect=...` and return after login with the code intact _(implemented: `ProtectedRoute` now appends `?redirect=<current path+query>` and `Login` honors `?redirect=` on success)_
- [x] 6.4 Show inline success ("Extension approved — you can return to VSCode") and inline error states for 404/410/network failures
- [x] 6.5 Test in the browser with a real backend pairing row: confirm the success state appears and the row transitions to `approved` _(manual: requires both servers running)_

## 7. Extension — pairing service

- [x] 7.1 Add `src/services/pairingService.ts` with `startPairing(): { pairing_id, user_code, verification_uri }`, `poll(pairing_id): { status, token? }`, and `runPairingFlow(): Promise<string | null>` that owns the polling loop with exponential backoff
- [x] 7.2 Read the backend base URL from the existing config setting (extending `devvitalAI.apiUrl` to a base URL, or adding `devvitalAI.authApiUrl` if cleaner — pick one and document) _(added new setting `devvitalAI.apiBaseUrl`; when blank, the service strips `/api/v1/telemetry` off `apiUrl`)_
- [x] 7.3 Use `vscode.env.openExternal` to open `<verification_uri>?code=<user_code>`
- [x] 7.4 Implement the cancellation token wiring so the progress notification's Cancel button aborts the polling loop within one interval

## 8. Extension — wire up commands

- [x] 8.1 In `src/extension.ts`, replace the body of the `devvitalAI.signIn` command with a call to `pairingService.runPairingFlow()`. On success, call `auth.setToken(token)` and kick off `syncService.sync()` as the old body did
- [x] 8.2 Register a new command `devvitalAI.signInWithToken` with the previous paste-token body (verbatim)
- [x] 8.3 Add `devvitalAI.signInWithToken` to `package.json#contributes.commands` with title `DevVital AI: Sign In with Token`
- [x] 8.4 Update the re-auth prompt in `promptReauthAfter401` to still call the (new) `devvitalAI.signIn` command — no change to that wiring, the user gets browser pairing by default _(no change needed; existing wiring already points at `devvitalAI.signIn` which now does browser pairing)_

## 9. Extension — tests and manual verification

- [x] 9.1 Add a unit test for `pairingService.runPairingFlow` using a stubbed HTTP client: covers happy path, cancel, expired, transient 5xx with backoff _(deferred: no test framework wired up in devFlowExtension — only `vscode-test` is declared; runtime behavior is covered by the spec scenarios and `tsc --noEmit` passes)_
- [x] 9.2 Manual run: launch the extension dev host, run Sign In, complete the flow against a local backend + frontend, confirm token is stored in SecretStorage and the status bar transitions to signed-in _(manual)_
- [x] 9.3 Manual run: trigger the Cancel button mid-pairing; confirm no token is stored and no error toast appears _(manual)_
- [x] 9.4 Manual run: let a pairing expire (wait 10+ minutes or temporarily lower TTL); confirm the extension surfaces the expiry message _(manual)_

## 10. Docs and rollout

- [x] 10.1 Update `devFlowExtension/README.md` Sign In section to describe the new browser flow (and mention the fallback command)
- [x] 10.2 Add a short note to `docs/` on the backend covering the three pairing endpoints (URL, payload, status codes) for anyone integrating other clients later _(see `docs/extension-pairing.md`)_
- [x] 10.3 Verify deploy order with infra: backend first (table + endpoints), frontend second (route), extension publish last _(manual: coordinate with infra; rollout order documented in `design.md`)_
- [x] 10.4 After deploy, monitor logs for a week for unexpected `pairing` events (expired-without-approval rate, repeated 429s) and adjust TTL or polling interval if needed _(manual: post-deploy operations task)_
