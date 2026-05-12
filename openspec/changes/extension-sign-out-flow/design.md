## Context

The extension authenticates to the backend with a `dvf_` API token stored in VS Code SecretStorage (`AuthService` in [src/services/authService.ts](src/services/authService.ts)). The sync loop in [src/services/syncService.ts](src/services/syncService.ts) reads the token on every flush and attaches it as `Authorization: Bearer <token>`. There is no way for a user to sign out from within the extension, no recovery path when the backend revokes a token, and no visible indication of auth state.

The backend already supports the relevant flows: `verifyJwt` middleware ([src/middleware/auth.middleware.js](src/middleware/auth.middleware.js)) returns `401` for any unknown or revoked `dvf_` token, and `DELETE /auth/tokens/:id` revokes a token. No backend change is required.

## Goals / Non-Goals

**Goals:**
- A single user-facing action ("Sign Out") that puts the extension into a known signed-out state.
- Automatic, deterministic recovery when the backend rejects the stored token, without user intervention required to stop bad-token traffic.
- A persistent UI affordance (status bar) so the user always knows whether the extension is sending telemetry.

**Non-Goals:**
- Server-side token revocation as part of sign out. The token remains valid on the server until the user explicitly deletes it via the tokens API. Rationale below.
- Refresh tokens, token rotation, or expiry handling beyond what 401-detection already covers.
- A custom sign-in UI. Sign-in continues to go through the existing input box flow that takes a pasted `dvf_` token.
- Multi-account support.

## Decisions

### Sign Out is local-clear only, not server-revoke

When the user signs out, the extension calls `AuthService.clearToken()` and stops. It does **not** call `DELETE /auth/tokens/:id` against the backend.

**Why:** A combined "revoke then clear" has two failure modes that local-only doesn't: the network DELETE can fail (forcing a choice between "abort sign out" — bad UX — and "clear anyway" — defeats the purpose of the call), and a partial success leaves the server token alive while the extension forgets it. Local-only is one operation, atomic from the user's perspective, and works offline. A leftover server-side token row is harmless: the only thing that can use it is the device that just forgot it.

**Alternative considered:** Always DELETE first, then clear locally only if DELETE succeeds. Rejected because it makes sign out fail when the network is down, which is the exact moment a user might most want to sign out (e.g., losing a laptop).

If the user wants to revoke server-side, they have `DELETE /auth/tokens/:id` already.

### 401 triggers automatic local-clear and pause, not retry

When `syncService` receives a 401:
1. Clear the token from SecretStorage.
2. Stop the sync interval (no further flush attempts until re-auth).
3. Update the status bar to "Signed out".
4. Show a `showWarningMessage` notification with a "Sign In" button that re-runs the existing sign-in command.

**Why:** A 401 from this backend means the token is wrong, expired, or revoked — none of which a retry fixes. Continuing to send is wasted traffic; worse, in a deployed scenario it can mask real auth issues from the user. The notification is the explicit signal that something needs human action.

**Alternative considered:** Exponential backoff and retry. Rejected — 401 is deterministic, not transient. We do not auto-clear on 5xx or network errors; those keep retrying as today.

### Auth state lives in `AuthService`, surfaced via EventEmitter

`AuthService` gains a `vscode.EventEmitter<AuthState>` with two states: `SignedIn` and `SignedOut`. `setToken` fires `SignedIn`, `clearToken` fires `SignedOut`. The status bar item and sync service subscribe.

**Why:** Centralizes the source of truth. Both the status bar (passive observer) and the sync loop (which needs to start/stop on state change) need the same signal, and an EventEmitter is the VS Code-idiomatic pattern. Alternatives like polling `getToken()` or wiring callbacks through the command handler would couple components that should not know about each other.

### Status bar item is read-only at first, with a click action

The status bar item shows `$(check) DevVital` when signed in, `$(circle-slash) DevVital — Signed Out` when not. Clicking it runs `DevVital AI: Sign Out` when signed in and `DevVital AI: Sign In` when signed out.

**Why:** Cheap, discoverable, doesn't require a tree view or webview.

## Risks / Trade-offs

- **[Risk] A second extension instance (e.g., remote SSH window) keeps its copy of the token after the user "signs out" locally** → Mitigation: documented as a known limitation. The user can run `DELETE /auth/tokens/:id` to kill it everywhere. We considered broadcasting via `vscode.authentication` API but it's overkill for a single-user, single-token model.
- **[Risk] Status bar click is a destructive action one keystroke away (Sign Out)** → Mitigation: clicking the status bar runs the command, which `showWarningMessage`-confirms before clearing.
- **[Trade-off] 401 silently clearing the token means a backend bug that returns spurious 401s would log everyone out** → Acceptable because the user can re-paste their token in seconds and we'd notice via support traffic. Worth revisiting if we move to JWT-based extension auth where 401s might be more common.
- **[Trade-off] No server-side revocation on sign out means a stolen device with a cached token is still a problem until the user manually deletes the token** → Acceptable for v1; the "delete this token" flow already exists in the tokens API and can be exposed in UI later.
