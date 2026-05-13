## Why

The insight/recommendation popup driven by [`insight-scheduler`](src/services/insight-scheduler.js) and [`insight-trigger.service`](src/services/insight-trigger.service.js) fires only when (a) the 10-minute scheduler tick runs, (b) one of four deterministic rules matches (very long session, long+high churn, rapid switching, delete-heavy rewriting), (c) the cooldown has elapsed, and (d) the LLM produces a non-normal `state_type`. In normal use this means a demo audience may sit for many minutes without ever seeing the popup — even though the underlying system is healthy. We need a way to **prove the end-to-end recommendation flow works**, on demand, during a hackathon demo or a live debugging session, without waiting on the scheduler or hoping rules trip.

## What Changes

- Add `POST /api/v1/recommendations/trigger` to the backend, authenticated with the same JWT/`dvf_` token middleware used by the rest of `/recommendations`. Body `{ mode: 'real' | 'force' | 'demo' }`, default `'real'`.
  - `real`: invoke `evaluateUser(req.user.id)` once and return its result. Respects cooldown, Gemini config, and "no rule fired" gates exactly like the scheduler. Proves the *real* path.
  - `force`: expire the user's latest pending recommendation first (so cooldown is moot), then `evaluateUser`. Still uses real rules + Gemini; useful when you know an insight *should* fire but cooldown is in the way.
  - `demo`: fabricate a `WorkflowState` + `Recommendation` row with hardcoded canned text, no LLM call, no rule check. Bulletproof fallback when Gemini is unreachable or there's no real activity.
- Add `devvitalAI.triggerInsight` command to the extension. Surfaced in the command palette as **DevVital AI: Trigger Insight**. Opens a `showQuickPick` letting the user choose `real / force / demo`, POSTs to the new endpoint, then calls `recommendationService.pollAndNotify()` so the popup appears within the next poll tick (≤60s; immediate in practice).
- Document the endpoint and command in [docs/](docs/) so the demo runbook is reproducible.
- All three modes emit a `logger.info` line tagged `recommendation-trigger` for auditability.

Explicitly **out of scope**:
- Keyboard shortcuts (can be added later via user `keybindings.json`).
- Configurable demo text — the canned message is hardcoded.
- Rate limiting (the existing JWT auth is sufficient gate).
- Dashboard / UI in the frontend.
- Production hardening — this is a demo-tool escape hatch and the proposal should not be misread as a general-purpose feature.

## Capabilities

### New Capabilities
- `insight-triggering`: the device-driven entry point for invoking the LLM/rule-based insight pipeline on demand, distinct from the scheduler-driven path. Owns the `POST /recommendations/trigger` endpoint and the `mode` semantics.

### Modified Capabilities
<!-- none -->

## Impact

- Affected code (backend):
  - [src/routes/recommendations.routes.js](src/routes/recommendations.routes.js) — new route.
  - [src/controllers/recommendations.controller.js](src/controllers/recommendations.controller.js) — new `triggerRecommendation` handler.
  - [src/services/insight-trigger.service.js](src/services/insight-trigger.service.js) — exports `evaluateUser` (already exported); add a `forceEvaluateUser` helper that expires latest then evaluates, and a `createDemoRecommendation` helper for the canned path.
  - [openspec.yaml](openspec.yaml) — register the new endpoint + request/response schema for Ajv validation.
- Affected code (extension):
  - [package.json](../devFlowExtension/package.json) — register `devvitalAI.triggerInsight` in `contributes.commands`.
  - [src/extension.ts](../devFlowExtension/src/extension.ts) — register command handler; reuses the existing `RecommendationService` instance.
  - [src/services/recommendationService.ts](../devFlowExtension/src/services/recommendationService.ts) — add a `triggerInsight(mode)` method.
- Docs: brief addition to recommendation docs explaining the demo command (no separate runbook file).
- No database schema migration — uses existing `workflow_states` and `recommendations` tables.
- No frontend dashboard change.
- Cost: `real` and `force` each consume one Gemini API call (same as a scheduler tick). `demo` is free.
- Risk: a signed-in user can spam `demo` mode to flood their own recommendation history. Acceptable for a hackathon; would not be acceptable for a production rollout (call out in design as a known limitation).
