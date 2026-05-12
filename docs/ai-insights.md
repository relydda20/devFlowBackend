# AI Insights

A Gemini-powered pipeline that watches each user's metrics and surfaces concrete "consider doing X" recommendations when threshold rules suggest they may be stuck.

## How it works

1. The **insight scheduler** ticks every `INSIGHT_CHECK_INTERVAL_SECONDS` (default 600 s).
2. For each user with telemetry in the last `INSIGHT_ACTIVITY_WINDOW_MINUTES` (default 30), the **rule engine** evaluates today's metrics + current session.
3. If a rule fires AND the user is not in cooldown, the system asks **Gemini** (`gemini-1.5-flash` by default) to characterize the workflow state and propose one action.
4. Gemini returns strict JSON validated against an enum schema. Invalid responses are dropped, never persisted.
5. A `WorkflowState` row + a `Recommendation` row are written. Any prior pending recommendation for the user is marked `expired` in the same transaction.

The **one-pending-per-user invariant** prevents popup spam. There's always at most one recommendation with `user_action = NULL` per user.

## Threshold rules (current defaults)

- `very_long_session` — current session duration > 240 minutes.
- `long_session_high_churn` — session > 120 min AND today's churn ratio > 0.4.
- `rapid_context_switching` — today's `rapid_switch_count` > 30.
- `delete_heavy_rewriting` — today's `lines_deleted > lines_added` AND total > 50.

The rule names are passed to Gemini as `triggered_rule` so the model has context on what brought the user to its attention. Rules live in [src/services/insight-trigger.service.js](../src/services/insight-trigger.service.js); tune them once you have real data.

## Cooldown + snooze

After a recommendation fires, the user is ignored for `INSIGHT_COOLDOWN_MINUTES` (default 45). If the user clicks **Snooze 30m**, that's replaced by `SNOOZE_DURATION_MINUTES` (default 30) starting from the snooze action.

## LLM contract

Gemini is called with `responseMimeType: 'application/json'`. The required response shape:

```json
{
  "state_type": "stuck_loop | lost_in_codebase | ai_dependency_trap | integration_hell | analysis_paralysis | normal",
  "confidence_score": 0.0,
  "recommendation_type": "change_approach | map_system | stop_using_ai | simplify_problem | execute",
  "recommendation_text": "<= 240 chars, second-person, single concrete action",
  "reasoning": "<= 600 chars, plain prose"
}
```

If Gemini returns `state_type: "normal"` it's the model's way of disagreeing with the rule trigger; a `WorkflowState` row is recorded but no `Recommendation` is created, and no popup fires.

## Surfaces

- **Dashboard** — `/dashboard` shows the 10 most recent recommendations in the RecommendationsPanel, with badges per `state_type`, a "Why this?" expander revealing the LLM reasoning, and action buttons on pending rows.
- **VS Code extension** — every 60 s the extension polls `GET /api/v1/recommendations/pending`. When a new pending recommendation appears, a non-modal `showInformationMessage` fires with three buttons: **Take it**, **Snooze 30m**, **Dismiss**. The toast can be closed without choosing — the recommendation stays pending and will re-appear on the next poll.

Both surfaces hit the same `POST /api/v1/recommendations/:id/action` endpoint to record the user's response.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/v1/recommendations/pending` | Single pending recommendation, or `{ recommendation: null }`. Used by the extension. |
| `GET /api/v1/recommendations?limit=N` | History (max 100). Used by the dashboard. |
| `POST /api/v1/recommendations/:id/action` | Record `accepted | dismissed | snoozed`. Returns 409 if already acted on. |

All require JWT or `dvf_` API token auth. The action endpoint also verifies ownership; 403 if a user tries to act on someone else's recommendation.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GOOGLE_API_KEY` | _(unset)_ | Required to enable the pipeline. Unset = scheduler logs a single warning at boot and disables itself; rest of the API works. |
| `GEMINI_MODEL` | `gemini-1.5-flash` | Model name passed to the SDK. |
| `INSIGHTS_ENABLED` | `true` | Kill switch. Set to `false` to disable the scheduler. |
| `INSIGHT_CHECK_INTERVAL_SECONDS` | `600` | How often the scheduler ticks. |
| `INSIGHT_COOLDOWN_MINUTES` | `45` | Minimum gap between recommendations for the same user. |
| `SNOOZE_DURATION_MINUTES` | `30` | How long a user-snooze suppresses re-firing. |
| `INSIGHT_ACTIVITY_WINDOW_MINUTES` | `30` | Users with no telemetry in this window are skipped (no LLM call). |

## Known limitations

- **Process-local concurrency.** The scheduler uses an in-memory Set to prevent re-entrant evaluation per user. If we ever run two backend replicas, both could fire for the same user in the same tick. A `(user_id, created_at)` uniqueness gate within a 5-minute window at insert time is the easy fix when we get there.
- **No outcome tracking yet.** `recommendations.outcome_improved` is nullable and unused. A future change can compare metrics before/after to mark "did taking this advice actually help?"
- **Threshold defaults are starting guesses.** Tune from production data; they live in one file ([insight-trigger.service.js](../src/services/insight-trigger.service.js)).
- **No CSRF token on the action endpoint.** It relies on the same cookie + CORS-allowlist defense as the rest of the API.
- **Extension polls every 60 s.** Worst case the popup is delayed by one poll interval. Acceptable for "consider a break" UX.

Cross-reference: this pipeline reads from `metrics_daily` and `metrics_session` populated by the [metrics ETL](metrics.md).
