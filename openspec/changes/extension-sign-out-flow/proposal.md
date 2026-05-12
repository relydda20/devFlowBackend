## Why

The VS Code extension stores its `dvf_` API token in SecretStorage but provides no way for the user to sign out, and it keeps sending telemetry indefinitely even when the token has been revoked server-side. Right now, "logging out" of the web app does nothing to the extension, and a 401 from the backend is treated the same as a transient error — telemetry silently keeps trying with a dead token. Users have no visibility into whether they are signed in.

## What Changes

- Add a `DevVital AI: Sign Out` command that clears the stored API token from SecretStorage and surfaces a prompt to sign in again.
- When the sync service receives a `401 Unauthorized` from the backend, automatically clear the stored token, stop the sync loop, and show a "Sign in again" notification with a button that re-runs the sign-in flow.
- Add a status bar item that reflects the current auth state (Signed in / Signed out) so users can see at a glance whether telemetry is being sent.
- Do **not** call the backend to revoke the token on sign out — local clear only. Server-side revocation is a separate operation users can perform via the existing `DELETE /auth/tokens/:id` endpoint.

## Capabilities

### New Capabilities
- `extension-auth`: Lifecycle and UX for the VS Code extension's API-token authentication — storing credentials, signing in, signing out, recovering from server-side revocation, and surfacing auth state.

### Modified Capabilities
<!-- None — backend API surface is unchanged. -->

## Impact

- **devFlowExtension**: new `signOut` command, status bar contribution, 401-handling branch in `syncService.ts`, small additions to `AuthService` for emitting state-change events.
- **devFlowBackend**: no code changes. The existing `DELETE /auth/tokens/:id` endpoint and `verifyJwt` middleware behavior are unchanged.
- **package.json (extension)**: register the new `devvital-ai.signOut` command.
- **User-visible**: a new menu command, a status bar indicator, and a notification when the token becomes invalid.
