## Why

To sign in today, a user runs `DevVital AI: Sign In` in VSCode and is asked to paste a `dvf_` API token into an input box ([devFlowExtension/src/extension.ts:122-144](../../../devFlowExtension/src/extension.ts#L122-L144)). The token must already exist — but the backend only exposes `POST /api/v1/auth/tokens` to JWT-authenticated callers ([devFlowBackend/src/routes/token.routes.js:8](../../src/routes/token.routes.js#L8)) and the frontend has no UI for minting one. In practice this means a user cannot self-serve: they must obtain a token out-of-band (DB shell, curl with a hand-crafted JWT) before the extension is usable.

The companion change [integrate-frontend-auth](../integrate-frontend-auth/proposal.md) is wiring the frontend's Login/Register pages to real backend auth, so logged-in users in the browser will soon have a JWT session. Once that lands, we can let the extension piggyback on the browser's session: the user clicks **Sign In** in VSCode, a browser tab opens to `/extension/pair`, the user clicks **Approve**, and the extension receives a freshly minted `dvf_` token without anyone copying and pasting anything. This is the same flow `gh auth login` and the Stripe/Linear CLIs use, and it is the "easier way" the user asked for.

## What Changes

**Backend** — add a device-code pairing capability backed by a short-lived `pairing_codes` table:
- `POST /api/v1/auth/pairings` (no auth): extension creates a pairing. Server returns `{ pairing_id, user_code, verification_uri, expires_in }`. `user_code` is a human-readable 8-char string (e.g. `BRWN-4F2X`); `pairing_id` is an opaque UUID the extension uses for polling. Default TTL: 10 minutes.
- `POST /api/v1/auth/pairings/:user_code/approve` (JWT-protected): frontend calls this when the logged-in user clicks **Approve**. Server marks the row `approved`, sets `user_id = req.user.id`, mints a `dvf_` token named `VSCode (paired YYYY-MM-DD)`, and stores its `id` on the row.
- `POST /api/v1/auth/pairings/:pairing_id/exchange` (no auth, rate-limited): extension polls this. Returns `{ status: 'pending' }` while waiting, `{ status: 'approved', token: 'dvf_...' }` once. The token is returned exactly once — subsequent polls return `{ status: 'consumed' }`. After exchange or expiry, the row is deleted.
- A new model `PairingCode { id, user_code, status (pending|approved|consumed), user_id (nullable), api_token_id (nullable), expires_at, created_at }` and a migration script under [db/migrations/](../../../db/migrations/) following the existing convention.
- Reuse the existing `verifyJwt` middleware and the existing `issueToken` service ([devFlowBackend/src/services/api-token.service.js:13](../../src/services/api-token.service.js#L13)) — no new token format.

**Frontend** — add a single new page and route:
- `/extension/pair` page that reads `?code=BRWN-4F2X` from the URL, shows the code prominently for visual confirmation, and renders an **Approve** button. If the user is not logged in, the existing `ProtectedRoute` (from [integrate-frontend-auth](../integrate-frontend-auth/proposal.md)) redirects to `/login?redirect=/extension/pair?code=...`. The button calls `POST /api/v1/auth/pairings/:user_code/approve` with credentials and shows a success state. Add to [devFlowFrontend/src/pages/](../../../devFlowFrontend/src/pages/) and wire into [App.tsx](../../../devFlowFrontend/src/App.tsx).

**Extension** — replace the default Sign In flow with browser pairing; keep paste-token as a fallback:
- `DevVital AI: Sign In` now calls `POST /pairings`, opens `vscode.env.openExternal(<verification_uri>?code=<user_code>)`, and polls `POST /pairings/:pairing_id/exchange` every 2s (with backoff on errors) until `approved` or `expired`. On success, store the returned `dvf_` token in `SecretStorage` via the existing [AuthService.setToken](../../../devFlowExtension/src/services/authService.ts#L17-L20) — no other code touched.
- Add a new command `DevVital AI: Sign In with Token` that runs the existing paste-token UX ([extension.ts:122-144](../../../devFlowExtension/src/extension.ts#L122-L144)) for users on machines that cannot open a browser (SSH, restricted containers).
- Show a progress notification ("Waiting for browser approval… Cancel") with a cancel action that aborts the polling loop. On expiry, surface "Pairing code expired — please try again."

## Capabilities

### New Capabilities
- `extension-pairing`: The device-code pairing flow that lets the VSCode extension obtain a `dvf_` API token by piggybacking on a logged-in browser session. Covers the three new backend endpoints, the `pairing_codes` table semantics (TTL, single-use), the frontend approval page behavior, and the extension's open-browser-and-poll loop including expiry and cancel handling.

### Modified Capabilities
None. The existing `api-tokens` spec already covers issuance, verification, and revocation of `dvf_` tokens; this change only adds a new *way to obtain* a token — it does not change what a token is or how it is verified. The pairing endpoints use `issueToken()` internally and produce tokens that flow through the existing verification middleware unchanged.

## Impact

- **Backend code**: new [src/controllers/pairing.controller.js](../../src/controllers/pairing.controller.js), new [src/services/pairing.service.js](../../src/services/pairing.service.js), new [src/routes/pairing.routes.js](../../src/routes/pairing.routes.js) (mounted under `/api/v1/auth/pairings`), new model [src/models/pairing-code.model.js](../../src/models/pairing-code.model.js), one new migration file in [db/migrations/](../../../db/migrations/), and an import line in [src/server.js](../../src/server.js). Validation schemas added under [src/middleware/validation.middleware.js](../../src/middleware/validation.middleware.js)'s schema registry.
- **Frontend code**: new [devFlowFrontend/src/pages/ExtensionPair.tsx](../../../devFlowFrontend/src/pages/ExtensionPair.tsx), one route added in [App.tsx](../../../devFlowFrontend/src/App.tsx). Uses the API client and `AuthProvider` from [integrate-frontend-auth](../integrate-frontend-auth/proposal.md).
- **Extension code**: replace body of the `devvitalAI.signIn` command in [extension.ts](../../../devFlowExtension/src/extension.ts), add a new `devvitalAI.signInWithToken` command (the old body, verbatim), add a new `pairingService.ts` under [src/services/](../../../devFlowExtension/src/services/). The `package.json` `contributes.commands` array gets one new entry.
- **Database**: one new table `pairing_codes`. No changes to existing tables. The table self-prunes (rows deleted on exchange or expiry); a periodic cleanup is *not* required for correctness but a simple `DELETE WHERE expires_at < NOW()` runner is added to the existing scheduler in [src/services/insight-scheduler.js](../../src/services/insight-scheduler.js) for hygiene.
- **Dependencies**: none. The extension already has `axios`; the backend already has `crypto` and `sequelize`.
- **Depends on**: [integrate-frontend-auth](../integrate-frontend-auth/proposal.md) for the frontend `AuthProvider`, `ProtectedRoute`, and `POST /api/v1/auth/login` returning a JWT cookie that the approval endpoint reads. If that change has not landed, the approval button can fall back to a "Log in first" link — but the happy path assumes it has.
- **Security**: the `user_code` is the only secret transmitted via URL/clipboard; the actual `dvf_` token is delivered only over the authenticated exchange and is never visible in browser history or copied to the clipboard. Pairings expire in 10 minutes; exchange is single-use; codes are randomly generated from an unambiguous alphabet (no `0/O`, `1/I/l`) to be readable.
- **Out of scope** (deferred): renaming or revoking the paired token from inside the extension UI (use the existing `/auth/tokens` endpoints for now); QR-code rendering of `verification_uri` for the SSH case; refresh tokens or rotating the paired token; multi-device "approve all pending" UI on the frontend.
