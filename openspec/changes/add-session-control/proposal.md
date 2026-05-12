## Why

A "session" in the extension today is a single UUID created at `activate()` and held immutable for the lifetime of the VS Code window ([devFlowExtension/src/services/sessionService.ts](../../../devFlowExtension/src/services/sessionService.ts)). Two practical problems flow from that:

- A laptop left open over a weekend produces a single 60-hour session. Per-session metrics become meaningless — a "deep work block" and a "left-the-laptop-open-Friday-night" session look identical in the data.
- Users have no way to deliberately chunk their workday. Many people want "morning deep work" and "afternoon meetings" as separate sessions in their dashboard, not one fused blob.

Closing VS Code as the only session boundary fights how people actually use editors. We need two complementary controls: an automatic safety net (idle cap) and explicit user intent (commands).

## What Changes

- Make `SessionService.sessionId` mutable via a controlled `rotate()` method. Existing readers continue to use `getSessionId()` and always see the current value.
- Add idle-cap rotation: if no events have been recorded for `IDLE_SESSION_TIMEOUT_MS` (default 30 minutes), the next event will be tagged with a freshly rotated `session_id`. The previous session is left as-is in the backend; no end-time backfill is performed.
- Add `DevVital AI: Start New Session` command — manually rotates `sessionId` immediately, regardless of idle state.
- Add `DevVital AI: End Session` command — same effect as Start New Session (rotates the id) but framed as "closing out" the current session. The next collected event opens a fresh session.
- Reset the in-memory aggregates (`activeMs`, `idleMs`, `totalEventsCollected`, `saveEvents`, `editorSwitchEvents`, `startedAt`, `lastActivityAt`) on every rotation, so session aggregates are scoped to the new session.
- Expose `sessionsRotated` count in the output channel for diagnostic visibility.
- Add a new extension setting `devvitalAI.idleSessionTimeoutMinutes` (default 30, minimum 1) so users can tune the idle cap.

## Capabilities

### New Capabilities
<!-- None. extension-integration already covers session_id semantics. -->

### Modified Capabilities
- `extension-integration`: The contract on `session_id` semantics expands. Today the spec implies one session per window; this change adds an idle-cap auto-rotation and two user-initiated rotation commands. The on-the-wire contract (every event carries the *current* `session_id`) is unchanged — the backend continues to upsert sessions and persist activities exactly as before.

## Impact

- **Extension code**: [devFlowExtension/src/services/sessionService.ts](../../../devFlowExtension/src/services/sessionService.ts) (sessionId becomes mutable, add rotate(), reset aggregates), [devFlowExtension/src/extension.ts](../../../devFlowExtension/src/extension.ts) (register two new commands), [devFlowExtension/src/constants/telemetryConfig.ts](../../../devFlowExtension/src/constants/telemetryConfig.ts) (add `IDLE_SESSION_TIMEOUT_MS`), [devFlowExtension/package.json](../../../devFlowExtension/package.json) (declare commands and the new configuration setting).
- **Backend code**: None. The backend's session-upsert logic already correctly handles a new `session_id` arriving in a telemetry payload by creating a fresh `Session` row.
- **Database**: None. Backend tables are unchanged.
- **No impact** on the metrics ETL: `metrics_session` is keyed on `session_id`, so each rotated session naturally gets its own row. `metrics_daily` continues to roll up across sessions for the same `(user_id, date)`.
- **User-visible**: two new command-palette entries, a new setting in VS Code preferences, and naturally smaller/more-meaningful session boundaries in the future dashboard.
