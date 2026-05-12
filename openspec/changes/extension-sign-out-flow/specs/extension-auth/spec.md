## ADDED Requirements

### Requirement: Sign Out command clears stored credentials

The extension SHALL provide a `DevVital AI: Sign Out` command that removes the stored API token from VS Code SecretStorage and transitions the extension into the signed-out state. The command MUST be available from the VS Code command palette and from the status bar item when signed in.

#### Scenario: User signs out while signed in
- **WHEN** the user runs `DevVital AI: Sign Out` while a token is stored
- **THEN** the token is removed from SecretStorage
- **AND** the extension stops attempting to flush telemetry
- **AND** the status bar reflects the signed-out state
- **AND** the extension does not call the backend to revoke the token

#### Scenario: User runs Sign Out while already signed out
- **WHEN** the user runs `DevVital AI: Sign Out` and no token is stored
- **THEN** the command completes without error
- **AND** the extension remains in the signed-out state

### Requirement: Extension auto-clears the token on backend 401

When a telemetry sync request to the backend responds with HTTP `401 Unauthorized`, the extension SHALL treat the stored token as invalid: it MUST clear the token from SecretStorage, stop the sync loop, and surface a notification to the user. The extension MUST NOT retry the same token after a 401.

#### Scenario: Backend rejects the stored token
- **WHEN** the sync service sends a telemetry batch with the stored token
- **AND** the backend responds with status `401`
- **THEN** the extension clears the token from SecretStorage
- **AND** the sync loop pauses (no further flush attempts until re-auth)
- **AND** the extension shows a warning notification offering a "Sign In" action

#### Scenario: User clicks Sign In from the 401 notification
- **WHEN** the user clicks the "Sign In" button on the 401 notification
- **THEN** the extension runs the existing sign-in flow (token input box)

#### Scenario: Sync request fails with a non-401 error
- **WHEN** the sync service sends a telemetry batch
- **AND** the backend responds with a 5xx status or a network error occurs
- **THEN** the extension does NOT clear the token
- **AND** the sync loop continues retrying on its normal cadence

### Requirement: Extension exposes auth state via a status bar item

The extension SHALL display a status bar item that reflects the current auth state. When signed in, it MUST indicate that telemetry is being sent. When signed out, it MUST indicate that telemetry is paused. The item MUST be clickable.

#### Scenario: Status bar reflects signed-in state
- **WHEN** a valid token is stored in SecretStorage
- **THEN** the status bar item displays a signed-in indicator (e.g., `$(check) DevVital`)
- **AND** clicking the item invokes the `DevVital AI: Sign Out` command

#### Scenario: Status bar reflects signed-out state
- **WHEN** no token is stored
- **THEN** the status bar item displays a signed-out indicator (e.g., `$(circle-slash) DevVital — Signed Out`)
- **AND** clicking the item invokes the `DevVital AI: Sign In` command

#### Scenario: Status bar updates immediately on auth state change
- **WHEN** the stored token is set, cleared, or auto-cleared due to a 401
- **THEN** the status bar item updates within the same event loop turn without requiring a window reload

### Requirement: Sign Out asks for confirmation before clearing

To prevent accidental sign-outs (e.g., via a misclick on the status bar), the `DevVital AI: Sign Out` command SHALL prompt the user for confirmation before clearing the token. If the user declines, no state change occurs.

#### Scenario: User confirms sign out
- **WHEN** the user invokes `DevVital AI: Sign Out`
- **AND** confirms the prompt
- **THEN** the token is cleared and the extension transitions to signed-out

#### Scenario: User cancels the sign out prompt
- **WHEN** the user invokes `DevVital AI: Sign Out`
- **AND** dismisses or declines the confirmation
- **THEN** the token is not cleared
- **AND** the extension remains in its previous state
