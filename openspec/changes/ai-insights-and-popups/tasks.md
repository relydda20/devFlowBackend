## Notes on implementation deltas

- **Extension polling is a SECOND independent setInterval, not a hook into the existing telemetry-sync timer.** Coupling them would have meant either modifying `SyncService` to know about recommendations (bad) or refactoring `setInterval` ownership (out of scope). Two timers tick in parallel; they fail independently. The 60-second cadence and signed-in gating are identical.
- **API base derivation in the extension.** The extension's existing `devvitalAI.apiUrl` setting is the FULL telemetry-endpoint URL (`http://localhost:3000/api/v1/telemetry`), not a host base. The new `RecommendationService` derives the v1 base by slicing off everything past `/api/v1`. Documented inline.
- **No new validation in the shared `validateRequest` middleware.** The action endpoint validates the body inline in the controller, matching the pattern in `metrics.controller.js`. The shared middleware only validates POST bodies against the openspec.yaml schemas; we don't need that level of formality for one field.
- **Gemini's `responseMimeType: 'application/json'`** does the heavy lifting on structured output. AJV is the validation gate after parse. On any failure (parse OR validation), the trigger logs and skips the tick — no row written.
- **`state_type: "normal"` is a vote-no.** When the LLM disagrees with the rule trigger, we write a `WorkflowState` row but NOT a `Recommendation`. The user never sees a popup. This is intentional — we want a record that the rule fired but the LLM judged it a false positive.

## 1. Backend: dependencies and config

- [x] 1.1 `@google/generative-ai` installed
- [x] 1.2 New env vars documented in [.env.example](.env.example)
- [x] 1.3 Stale `LLM_PROVIDER=openai` / `OPENAI_API_KEY` lines removed from `.env.example`

## 2. Backend: Gemini service

- [x] 2.1 [src/services/llm/gemini.service.js](src/services/llm/gemini.service.js) — single `generateInsight(...)` export; reads `GOOGLE_API_KEY` once at module load; never logs it
- [x] 2.2 System prompt: hardcoded inline. Documents enums + tone + "be specific, not generic"
- [x] 2.3 User prompt built from `{ metrics, session, topFiles, triggeredRule }`
- [x] 2.4 `responseMimeType: 'application/json'` + temperature 0.4
- [x] 2.5 AJV validates against the canonical enums. `GeminiValidationError` carries the invalid payload for logging
- [x] 2.6 Errors propagate; no side effects on failure

## 3. Backend: insight trigger and scheduler

- [x] 3.1 [src/services/insight-trigger.service.js](src/services/insight-trigger.service.js) — `evaluateUser(userId)` with rule engine + cooldown/snooze logic
- [x] 3.2 Four named rules: `very_long_session`, `long_session_high_churn`, `rapid_context_switching`, `delete_heavy_rewriting`
- [x] 3.3 `inCooldown`/`isInCooldown` derived from `MAX(recommendations.created_at)` per user, with snooze override
- [x] 3.4 [src/services/insight-scheduler.js](src/services/insight-scheduler.js) — `start/stop/tick` with in-memory Set for per-user concurrency, mirroring [metrics-etl-scheduler.js](src/services/metrics-etl-scheduler.js)
- [x] 3.5 The scheduler tick lists active users + processes each via `Promise.all`. Persistence does transactional one-pending invariant + writes WorkflowState/Recommendation
- [x] 3.6 [server.js](src/server.js) starts the insight scheduler after `app.listen`; SIGTERM/SIGINT stops both schedulers; skip if `INSIGHTS_ENABLED=false` or key unset

## 4. Backend: recommendations controller + routes

- [x] 4.1 [src/controllers/recommendations.controller.js](src/controllers/recommendations.controller.js) — `getPending`, `getRecent`, `postAction` with ownership check + 409 on already-acted
- [x] 4.2 [src/routes/recommendations.routes.js](src/routes/recommendations.routes.js) — three routes, all `verifyJwt`
- [x] 4.3 Router mounted in [server.js](src/server.js) at `/api/v1`
- [x] 4.4 [openspec.yaml](openspec.yaml) updated with the three endpoints. Total endpoints now 17 (up from 14)

## 5. Frontend: recommendations API client + hook

- [x] 5.1 [src/lib/recommendations.ts](../../../devFlowFrontend/src/lib/recommendations.ts) — typed `Recommendation`, `getRecent`, `postAction`, reuses `ApiError`
- [x] 5.2 Pending endpoint is extension-only; frontend uses `getRecent` (correct)
- [x] 5.3 RecommendationsPanel uses `useMetric` for the list — same loading/error/401 contract as metric cards

## 6. Frontend: RecommendationsPanel component

- [x] 6.1 [src/components/dashboard/RecommendationsPanel.tsx](../../../devFlowFrontend/src/components/dashboard/RecommendationsPanel.tsx) — list of rows with badge, text, action label, "Why this?" expander
- [x] 6.2 Optimistic local-state overrides on button click; rolls back to server data on error via an inline error message
- [x] 6.3 Loading skeleton, empty state, error+retry — all three states covered
- [x] 6.4 Panel wired into [Dashboard.tsx](../../../devFlowFrontend/src/pages/Dashboard.tsx). Old "AI Insights — Preview" card removed

## 7. Extension: recommendation polling and popups

- [x] 7.1 [src/services/recommendationService.ts](../../../devFlowExtension/src/services/recommendationService.ts) — `pollAndNotify()` method; derives API base from `devvitalAI.apiUrl`
- [x] 7.2 New `setInterval` in [extension.ts](../../../devFlowExtension/src/extension.ts) (60 s cadence), gated by `signedIn && !lastAuthFailure`. Independent of the sync timer.
- [x] 7.3 In-memory `lastShownId` prevents re-showing the same recommendation across ticks
- [x] 7.4 Action POSTs use the existing API token. Errors logged to output channel; never block the next tick.
- [x] 7.5 Closing the toast without clicking a button records nothing; the next tick re-shows it (per spec)
- [x] 7.6 Polling gated by signed-in state
- [x] 7.7 No package.json updates needed (no new commands or settings)

## 8. Compile + lint

- [x] 8.1 Backend: `node --check` clean; import graph loads OK (17 endpoints, up from 14)
- [x] 8.2 Frontend: lint clean, build clean (395 KB JS)
- [x] 8.3 Extension: compile clean, lint clean

## 9. Manual verification

- [ ] 9.1 Set `GOOGLE_API_KEY` in `.env`. Start the backend with `INSIGHT_CHECK_INTERVAL_SECONDS=60` for faster ticking
- [ ] 9.2 Trigger a rule (e.g., temporarily lower `very_long_session` to 5 min, or just code actively for >2h)
- [ ] 9.3 Wait one tick; confirm a `recommendations` row appears with non-null fields and `user_action IS NULL`
- [ ] 9.4 Open dashboard; confirm the RecommendationsPanel shows the new row + the three action buttons
- [ ] 9.5 Click "Why this?"; confirm the LLM reasoning expands
- [ ] 9.6 In a separate VS Code window, wait for the next sync tick; confirm the popup appears with Take it / Snooze 30m / Dismiss
- [ ] 9.7 Click "Snooze 30m"; confirm DB `user_action='snoozed'`; dashboard reflects it on refresh
- [ ] 9.8 Wait another tick; confirm no new popup (snooze respected)
- [ ] 9.9 Wait out the snooze (or lower `SNOOZE_DURATION_MINUTES`); confirm new pending row inserted, prior `snoozed` row unchanged
- [ ] 9.10 Unset `GOOGLE_API_KEY`; restart backend; confirm single warning logged, no crash, rest of API works
- [ ] 9.11 (Hard to manually trigger) — to test invalid LLM responses you could temporarily mock the Gemini service; expected behavior: no row written, warning logged
- [ ] 9.12 With two users, confirm `POST /recommendations/:other-id/action` returns 403

## 10. Documentation

- [x] 10.1 [docs/ai-insights.md](docs/ai-insights.md) created. Covers: pipeline, threshold rules, cooldown/snooze, LLM contract, both surfaces, endpoints, env vars, known limitations
- [x] 10.2 Cross-link to [docs/metrics.md](docs/metrics.md) included at the bottom of the new doc
- [x] 10.3 "One pending per user" invariant documented prominently in the "How it works" section
