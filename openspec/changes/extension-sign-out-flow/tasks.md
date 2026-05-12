## Notes on implementation deltas

- Command IDs use the existing `devvitalAI.*` (camelCase) namespace from the extension's [package.json](package.json), not the kebab-case shown in early drafts. Command: `devvitalAI.signOut`.
- The status bar uses `StatusBarAlignment.Right` (existing convention), not Left. Tri-state rendering: Signed out, signed-in-with-auth-failure, signed-in-healthy.
- 401 only (not 403) clears the token. 403 means authenticated-but-not-authorized — clearing the token wouldn't fix that.
- The 401 user-facing notification fires from the **flush command** path (`promptReauthAfter401`). For background timer-driven 401s, the user signal is the status bar flipping to "Signed Out" via the auth state change. The status bar item is clickable to trigger sign-in.

## 1. AuthService: emit state changes

- [x] 1.1 Add an `AuthState` type (`'signed-in' | 'signed-out'`) and a `vscode.EventEmitter<AuthState>` field to `AuthService` in [src/services/authService.ts](src/services/authService.ts)
- [x] 1.2 Expose a public `onDidChangeState: vscode.Event<AuthState>` derived from the emitter
- [x] 1.3 Fire `'signed-in'` from `setToken` after the store completes and `'signed-out'` from `clearToken` after the delete completes
- [x] 1.4 Add an `isSignedIn(): Promise<boolean>` helper so subscribers can resolve initial state on activation
- [x] 1.5 Dispose the emitter when the extension deactivates (push onto `context.subscriptions`)

## 2. Sign Out command

- [x] 2.1 Register `devvitalAI.signOut` in [package.json](package.json) `contributes.commands`
- [x] 2.2 In [src/extension.ts](src/extension.ts), register the command handler: show a modal confirmation ("Sign out of DevVital AI? Telemetry will stop until you sign in again."), and on confirm call `auth.clearToken()`
- [x] 2.3 Handle the already-signed-out case by completing silently (no error)
- [x] 2.4 Do not call the backend — local clear only (per design)

## 3. Sync service: 401 handling

- [x] 3.1 In [src/services/syncService.ts](src/services/syncService.ts), after the `axios.post` call, branch on `error.response?.status === 401`
- [x] 3.2 On 401: call `auth.clearToken()` (which fires the state change → sync subscribes and stops). The flush command surfaces a warning notification with a "Sign In" action; for background 401s the status bar flip is the signal.
- [x] 3.3 Ensure non-401 errors (5xx, network failures) continue to follow the existing retry behavior — do NOT clear the token
- [x] 3.4 When the sync service starts, subscribe to `auth.onDidChangeState`: resume the interval on `'signed-in'`, pause it on `'signed-out'`

## 4. Status bar item

- [x] 4.1 Keep the existing `vscode.StatusBarItem` (alignment: Right, priority: 100) in [src/extension.ts](src/extension.ts)
- [x] 4.2 Resolve the initial state from `auth.isSignedIn()` and render: `$(check) DevVital AI: <n> queued` (signed in), `$(alert) DevVital AI: Sign in required` (signed in + auth failure), or `$(circle-slash) DevVital AI: Signed Out` (signed out)
- [x] 4.3 Subscribe to `auth.onDidChangeState` and re-render on every event
- [x] 4.4 Bind `command` to `devvitalAI.showStatus` when signed-in-healthy and to `devvitalAI.signIn` when signed out / auth failure
- [x] 4.5 Push the status bar item onto `context.subscriptions` so it disposes cleanly

## 5. Tests and manual verification

- [ ] 5.1 Manual: sign in via existing flow, verify status bar shows signed-in, telemetry flushes
- [ ] 5.2 Manual: run Sign Out from the palette, confirm prompt, verify status bar flips and sync stops
- [ ] 5.3 Manual: with a stored token, delete the corresponding row from `api_tokens` in the DB, trigger a flush, confirm the 401 path clears the token, pauses sync, and shows the notification
- [ ] 5.4 Manual: click "Sign In" on the 401 notification and confirm the sign-in input box appears
- [ ] 5.5 Manual: click the status bar item in each state and confirm it invokes the right command
- [ ] 5.6 Manual: cancel the Sign Out confirmation prompt and confirm no state change occurs

## 6. Documentation

- [x] 6.1 Update [docs/extension.md](docs/extension.md) to describe the Sign Out command, status bar, and 401 auto-clear behavior
- [x] 6.2 Note the known limitation: Sign Out is local-only and does not revoke the token server-side; reference the existing `DELETE /auth/tokens/:id` endpoint for server-side revocation
