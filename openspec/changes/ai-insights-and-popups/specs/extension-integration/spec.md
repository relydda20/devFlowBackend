## ADDED Requirements

### Requirement: Extension polls for pending recommendations on sync tick

The extension SHALL call `GET /api/v1/recommendations/pending` once per telemetry sync tick (default 60 seconds). The call MUST use the existing API token authentication. The call MUST NOT block telemetry submission — both happen in the same tick but as independent network requests.

#### Scenario: Sync tick with a pending recommendation
- **WHEN** the sync tick fires and the backend returns a non-null pending recommendation
- **AND** the recommendation's `id` differs from the last id the extension showed
- **THEN** the extension fires a non-modal `showInformationMessage` with three action buttons: **Take it**, **Snooze 30m**, **Dismiss**
- **AND** the extension caches the recommendation `id` so the same one is not re-shown on subsequent ticks

#### Scenario: Sync tick with no pending recommendation
- **WHEN** the sync tick fires and the backend returns `{ recommendation: null }`
- **THEN** no notification is shown
- **AND** the cached "last shown id" is unchanged

#### Scenario: Pending poll fails
- **WHEN** the pending-poll request fails (network, 5xx)
- **THEN** the error is logged to the output channel
- **AND** telemetry submission in the same tick is unaffected

#### Scenario: Recommendation polling is gated by signed-in state
- **WHEN** the user is signed out (no API token)
- **THEN** the extension does not call the recommendations endpoint
- **AND** no notification can fire

### Requirement: Notification action buttons record user feedback

When the user clicks any of the three notification buttons, the extension SHALL call `POST /api/v1/recommendations/:id/action` with the corresponding action (`accepted` for Take it, `snoozed` for Snooze 30m, `dismissed` for Dismiss). The extension MUST NOT pre-act on behalf of the user — closing the toast without clicking a button leaves the recommendation `pending`.

#### Scenario: User clicks "Take it"
- **WHEN** the user clicks **Take it** on a recommendation notification
- **THEN** the extension POSTs `{ action: 'accepted' }` to the action endpoint
- **AND** the cached "last shown id" prevents re-showing on the next tick

#### Scenario: User clicks "Snooze 30m"
- **WHEN** the user clicks **Snooze 30m**
- **THEN** the extension POSTs `{ action: 'snoozed' }`
- **AND** the cached id prevents re-showing on the next tick

#### Scenario: User clicks "Dismiss"
- **WHEN** the user clicks **Dismiss**
- **THEN** the extension POSTs `{ action: 'dismissed' }`
- **AND** the cached id prevents re-showing on the next tick

#### Scenario: User closes the toast without clicking a button
- **WHEN** the user dismisses the VS Code notification via its close button (NOT one of our three action buttons)
- **THEN** the extension does NOT record any action
- **AND** the recommendation remains `pending` server-side
- **AND** the next sync tick (which fetches `pending` again) re-shows the same recommendation
