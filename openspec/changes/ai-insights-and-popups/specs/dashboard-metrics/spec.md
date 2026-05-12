## ADDED Requirements

### Requirement: Dashboard renders a Recommendations panel

The dashboard SHALL render a Recommendations panel that lists the user's recent recommendations. The panel reads from `GET /api/v1/recommendations?limit=N` (default `limit=10`). Each row MUST show: `created_at` (relative, e.g., "2h ago"), a state badge color-coded by `state_type`, the `recommendation_text`, and the user's recorded action (Accepted / Dismissed / Snoozed / Expired / Pending).

The placeholder "AI Insights" preview card from prior changes is replaced by this panel.

#### Scenario: User has recent recommendations
- **WHEN** the dashboard loads and the user has 3 recommendations in their history
- **THEN** the panel displays 3 rows, newest first
- **AND** each row shows the timestamp, state badge, text, and action

#### Scenario: User has no recommendations
- **WHEN** the dashboard loads and the user has never had a recommendation
- **THEN** the panel renders an empty state: "No insights yet. They'll appear here when we spot something worth surfacing."

#### Scenario: Loading state
- **WHEN** the recommendations request is in flight
- **THEN** the panel renders a skeleton placeholder

#### Scenario: Error state
- **WHEN** the recommendations request fails (non-401)
- **THEN** the panel renders an error message with a retry button
- **AND** the rest of the dashboard's metric cards continue to render

#### Scenario: 401 on recommendations call
- **WHEN** the recommendations request returns 401
- **THEN** the same logout-on-401 behavior as the metrics cards applies (the user is signed out and redirected to /login)

### Requirement: Pending recommendations are actionable on the dashboard

When a recommendation in the panel has `user_action = NULL` (pending), the row MUST display three action buttons (Accept, Snooze, Dismiss). Clicking a button calls `POST /api/v1/recommendations/:id/action` and updates the row inline once the call resolves.

#### Scenario: Pending row has action buttons
- **WHEN** a row's `user_action` is `null`
- **THEN** three buttons are rendered: Accept (green), Snooze (slate), Dismiss (gray)

#### Scenario: Acted-on row shows no action buttons
- **WHEN** a row's `user_action` is `'accepted'`, `'dismissed'`, `'snoozed'`, or `'expired'`
- **THEN** the action label is displayed (e.g., "Accepted") and no buttons are shown

#### Scenario: User clicks Accept on the dashboard
- **WHEN** the user clicks the Accept button on a pending row
- **THEN** the dashboard POSTs `{ action: 'accepted' }` to the action endpoint
- **AND** on success, the row updates inline to show "Accepted"
- **AND** the buttons are removed

#### Scenario: Action click fails
- **WHEN** the POST fails (non-2xx)
- **THEN** an inline error is shown next to the buttons
- **AND** the buttons remain visible for retry

### Requirement: Recommendation reasoning is revealable

Each row in the panel MUST include an expandable "Why this?" control that reveals the LLM's `reasoning` text. Default state is collapsed.

#### Scenario: Expand reasoning
- **WHEN** the user clicks the "Why this?" control on a row
- **THEN** the row expands to show the `reasoning` text
- **AND** the control toggles to "Hide reasoning"
