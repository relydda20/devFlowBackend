## Why

We collect rich workflow telemetry and aggregate it into churn / context-switching / session metrics, but the data sits inert. The two existing tables `workflow_states` and `recommendations` were designed to hold AI-derived insights and have always been empty. The Dashboard's "AI Insights" card and the extension's `Take a Break` button are both placeholder UI with no backing data.

This change wires the missing brain in: a Gemini-powered insight service that watches each user's recent metrics and, when threshold rules say something looks off (long session + high churn + lots of context switching), asks Gemini to characterize the workflow state and recommend one concrete action. The recommendation surfaces in two places:

- A new dashboard panel that lists the user's recent recommendations and lets them mark each one accepted / dismissed / snoozed.
- A VS Code notification popup in the extension when a fresh recommendation exists, with the same accept / dismiss / snooze actions.

Both surfaces feed back into the `recommendations.user_action` and `outcome_improved` columns so the system can later learn which suggestions actually help.

## What Changes

**Backend — LLM + insight pipeline**
- Add a Gemini service module that wraps `@google/generative-ai`. Reads `GOOGLE_API_KEY` and `GEMINI_MODEL` (default `gemini-1.5-flash`). Exposes a single typed `generateInsight(input)` function.
- Add an `InsightTrigger` rule engine that runs every `INSIGHT_CHECK_INTERVAL_SECONDS` (default 600 — 10 minutes) per active user. The rule engine inspects today's churn, switching, top files, and current session length, and decides whether to invoke the LLM. Specific thresholds documented in design.md.
- The trigger sets a per-user cooldown of `INSIGHT_COOLDOWN_MINUTES` (default 45) after firing, so users don't get spam during a sustained rough stretch.
- The LLM returns structured JSON: `{ state_type, confidence_score, recommendation_type, recommendation_text, reasoning }`. `state_type` and `recommendation_type` MUST be drawn from the existing enums in [openspec.yaml](openspec.yaml).
- Persist one `WorkflowState` row + one linked `Recommendation` row per LLM call. Free-text `reasoning` is stored on the recommendation as additional context.
- Add endpoints:
  - `GET /api/v1/recommendations/pending` — for the extension; returns the most recent un-acted recommendation, if any.
  - `GET /api/v1/recommendations?limit=N` — for the dashboard; returns the user's recent recommendations with their `user_action` and `created_at`.
  - `POST /api/v1/recommendations/:id/action` with body `{ action: 'accepted' | 'dismissed' | 'snoozed' }` — records the user's response.

**Frontend dashboard**
- New "Recommendations" panel on the dashboard, replacing the placeholder copy in the existing "AI Insights" card. Lists the 10 most recent recommendations with: timestamp, recommendation text, state badge (color-coded by `state_type`), and the user's recorded action (Accepted / Dismissed / Snoozed / Pending).
- For pending recommendations, the three action buttons hit `POST /recommendations/:id/action`. After an action, the row updates inline.
- Add a small "Why this?" expander that reveals the LLM's `reasoning` text for users who want context.

**Extension popup**
- Extend the existing telemetry sync interval in [syncService.ts](../../../devFlowExtension/src/services/syncService.ts) to also call `GET /api/v1/recommendations/pending` on each tick (default 60s).
- When a pending recommendation is returned and its `id` differs from the last one we showed, fire a `vscode.window.showInformationMessage` with three buttons: **Take it**, **Snooze 30m**, **Dismiss**. The user's choice calls the `POST /:id/action` endpoint.
- A snoozed recommendation is honored by the backend trigger engine for `SNOOZE_DURATION_MINUTES` (default 30), then the cooldown resumes normal logic.

## Capabilities

### New Capabilities
- `ai-insights`: The Gemini-powered insight pipeline — trigger rules, LLM prompt + JSON schema, persistence, the three new endpoints, the user-action feedback loop, and the snooze / cooldown rules.

### Modified Capabilities
- `extension-integration`: The extension's sync tick gains a second responsibility (recommendation polling) and a new notification surface. The auth + telemetry contract is unchanged.
- `dashboard-metrics`: Adds a Recommendations panel to the dashboard. The metric-card flow is unchanged.

## Impact

- **Backend code**: new [src/services/llm/gemini.service.js](src/services/llm/gemini.service.js), new [src/services/insight-trigger.service.js](src/services/insight-trigger.service.js), new [src/services/insight-scheduler.js](src/services/insight-scheduler.js), new [src/controllers/recommendations.controller.js](src/controllers/recommendations.controller.js), new [src/routes/recommendations.routes.js](src/routes/recommendations.routes.js), small additions to [src/server.js](src/server.js) to start the scheduler.
- **Backend dependencies**: `@google/generative-ai`.
- **Database**: no schema changes. Both `workflow_states` and `recommendations` tables already exist. We may add a small index on `recommendations(workflow_state_id, created_at)` if scan profiling shows it; deferred.
- **Env vars (new)**: `GOOGLE_API_KEY`, `GEMINI_MODEL`, `INSIGHT_CHECK_INTERVAL_SECONDS`, `INSIGHT_COOLDOWN_MINUTES`, `SNOOZE_DURATION_MINUTES`, `INSIGHTS_ENABLED` (kill switch).
- **Frontend code**: new [src/lib/recommendations.ts](../../../devFlowFrontend/src/lib/recommendations.ts) (API client), new [src/components/dashboard/RecommendationsPanel.tsx](../../../devFlowFrontend/src/components/dashboard/RecommendationsPanel.tsx) (UI), modifications to [Dashboard.tsx](../../../devFlowFrontend/src/pages/Dashboard.tsx) to wire it in.
- **Extension code**: small additions to [src/services/syncService.ts](../../../devFlowExtension/src/services/syncService.ts) (or a new sibling service) for polling + notifications.
- **Cost**: Gemini `gemini-1.5-flash` calls. With a 10-minute scheduler tick and a 45-minute cooldown, an actively-coding user generates at most ~1.3 calls/hour. At Flash's free-tier-friendly pricing, this is negligible.
- **Backwards-compatible**: the extension's existing telemetry POST behavior is unchanged. The dashboard's existing metric cards are unchanged.
- **Out of scope (deferred)**: A/B testing recommendation phrasings, multi-language responses, calibration of `confidence_score` over time, user-tunable thresholds in settings UI, embedding-based memory of "what worked for this user."
