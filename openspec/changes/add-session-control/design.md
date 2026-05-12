## Context

`SessionService` in [devFlowExtension/src/services/sessionService.ts](../../../devFlowExtension/src/services/sessionService.ts) currently sets `sessionId` as a `readonly` field initialized once in the constructor. Every telemetry event is tagged with this id via [telemetryAggregator.ts](../../../devFlowExtension/src/services/telemetryAggregator.ts), and the backend's session-upsert ([src/services/telemetry.service.js](src/services/telemetry.service.js)) creates a new `Session` row the first time a new id arrives.

Because the id is set once and the aggregates (`activeMs`, `idleMs`, `totalEventsCollected`, etc.) are scoped to the service instance, "rotating" the id requires three coupled operations: emit a final snapshot for the old id if needed, generate a new id, and zero out the aggregates so the new session starts clean. Doing one without the others produces broken data: e.g., rotating the id but keeping `activeMs` would attribute time to the wrong session.

The metrics ETL adds an additional constraint worth respecting: `metrics_session` is keyed on `session_id`, so each rotation cleanly produces a new row — no migration or backfill is needed.

## Goals / Non-Goals

**Goals:**
- Three deterministic ways to start a new session: idle-cap auto-rotation, explicit `Start New Session`, explicit `End Session`. All three converge on the same `rotate()` method to keep behavior consistent.
- Aggregates always belong to exactly one session. Rotating mid-stream cannot leak counters across the boundary.
- Backwards-compatible on the wire: the backend sees the same `session_id` field with the same semantics; the only difference is it sees more distinct ids per VS Code window.
- The user gets observable feedback that a rotation happened (output channel log line) without spamming notifications.

**Non-Goals:**
- Pause / resume telemetry. Distinct feature; the user can sign out if they want a hard stop.
- A custom UI for session listing, naming, or labeling. Captured as a "maybe" in the metrics-ETL design; out of scope here.
- Modifying the backend session table or the upsert behavior. The backend already handles unfamiliar `session_id`s correctly.
- Persisting the current `session_id` across VS Code restarts. A restart always opens a fresh session — keeping the same id across restarts would require local persistence with unclear value.
- A "sign out from the bottom of the screen" wiring change. The user said keep current behavior; revisit if they ask.

## Decisions

### One `rotate()` method, three callers

`Start New Session`, `End Session`, and the idle-cap check all call the same `SessionService.rotate(reason)` method. The reason is logged for observability but does not change behavior.

**Why:** Three identical-looking but slightly different code paths is exactly how subtle bugs are born ("Start New zeroed activeMs but End Session didn't"). One method = one truth. The two commands differ only in their command id and palette label; the underlying behavior is the same.

**Alternative considered:** Two methods (`startNew`, `end`) that differ in whether they emit a "session ended" telemetry event. Rejected because we have no "session_end" event type on the wire today and adding one is a bigger contract change for limited value — the backend can infer end times from gaps in the activities stream if it ever needs to.

### Idle-cap is checked lazily, on the next event — not on a timer

The aggregator's "collect an event" path checks `Date.now() - lastActivityAt > IDLE_SESSION_TIMEOUT_MS`. If true, it calls `rotate('idle')` *before* recording the event. The event then tags with the new id.

**Why:**
- No `setTimeout` to manage, no race with the aggregator, no extra disposal logic at deactivation.
- The check only runs when something is actually happening. An idle laptop with VS Code open does literally nothing — no timer, no wakeup, no battery drain.
- The newly-rotated session always starts with a real event, which is what the metrics dashboard wants.

**Alternative considered:** A `setInterval` that checks every minute and rotates proactively. Rejected — it adds background work for no value, since with no events, an empty rotated session would never produce a `metrics_session` row anyway. The lazy check produces the same observable behavior with less code.

### Rotation point: before the event is recorded

When a triggering event arrives after idle, the flow is:

1. Aggregator receives event.
2. Aggregator checks: idle threshold exceeded?
3. If yes, `sessionService.rotate('idle')` → new uuid, aggregates zeroed.
4. Aggregator continues recording: `sessionService.recordEvent(event)` → counters tick on the *new* session.
5. The event payload reads `sessionService.getSessionId()` → gets the new id.

**Why:** The triggering event is the first event of the new session, conceptually. If we rotated *after* recording, the event would be attributed to the old (now-stale) session, and the new session would start with zero events until the next keystroke. Both rules are defensible but "the first keystroke after a long break begins a new session" matches how a human would describe their workday.

### Explicit commands rotate even on a fresh session

If a user runs `Start New Session` 10 seconds after the extension activates (so the current session has near-zero events), we still rotate. The old session row in the backend will exist but be near-empty; the metrics ETL will create a near-empty `metrics_session` row. Acceptable.

**Why:** Surprising the user with "I didn't rotate because you just started" is worse UX than a slightly noisy session table. The user asked for a new session; we honor it. If the table starts growing unboundedly with near-empty sessions a year from now, prune.

### Settings: extension-level, not backend-level

`IDLE_SESSION_TIMEOUT_MS` is constant-defined with a default; the user can override via the `devvitalAI.idleSessionTimeoutMinutes` setting in VS Code. Default 30, min 1, no max (a user who wants 8 hours can have it).

**Why:** This is a personal preference (some users want 15-min focus blocks, others want 60-min "morning/afternoon" chunks). Putting it in the backend means every user shares the same value, which is wrong. The extension is the right home.

### Notification policy: log, do not notify

Rotations log a single line to the existing `DevVital AI` output channel: `Session rotated (reason: idle | manual_start | manual_end)`. No `showInformationMessage` toast.

**Why:** Idle rotations could happen multiple times a day in normal use; surfacing a toast each time would be annoying. Explicit commands already feel intentional (the user just ran the palette command), so the silence is fine. If diagnostics matter, the output channel is there.

## Risks / Trade-offs

- **[Risk] In-flight events between idle-check and rotation get attributed to the wrong session** → Mitigation: the aggregator is single-threaded JavaScript inside the extension host. The idle-check, the rotate call, and the recordEvent call all happen synchronously in the same microtask. No interleaving possible. Worth re-checking if we ever introduce async work in the collect path.
- **[Risk] Aggregates being reset on rotation means the `session` block in the next telemetry payload reports a smaller-than-expected `total_events_collected`** → This is correct: a new session genuinely has fewer events. Documented in the spec scenarios so dashboard consumers don't misread.
- **[Trade-off] A "session" no longer maps 1:1 to "I opened VS Code"** → That's the explicit intent. The cost is a slightly less intuitive answer to "how many sessions did I have?" — the user might have 3 in a single window. Mitigation: the dashboard exposes both `metrics_daily` (calendar-day) and `metrics_session` views, so users can frame it however they want.
- **[Trade-off] Empty/near-empty session rows from explicit commands run on fresh sessions** → Acceptable for v1; revisit if metrics_session ever gets unwieldy. A simple cleanup (drop rows with `total_events_collected < 3` older than N days) is trivial to add later.
- **[Risk] A user changes the idle threshold to 1 minute and sees 30+ sessions/day, finding it confusing** → Mitigation: the default is generous (30 min). The setting's description in package.json explicitly tells the user what the trade-off is.
- **[Risk] Tests against `SessionService.sessionId` written as a constant fact will break** → No such tests exist in the extension today (the project has no test framework). Not a real concern, but if one materializes later it's a 5-line fix.
