## Context

The recommendation system in [insight-scheduler.js](src/services/insight-scheduler.js) runs `evaluateUser` on a configurable interval (default 10 min) for every active user. `evaluateUser` gates on Gemini being configured, cooldown not elapsed, a current session existing, at least one of four rules firing on `metrics_daily`, and the LLM returning a non-`normal` `state_type`. Any one failing → no recommendation → no popup. For a hackathon demo this means the audience may see nothing for the whole 10-minute window.

Today the extension [`RecommendationService`](../devFlowExtension/src/services/recommendationService.ts) polls `GET /recommendations/pending` every 60s and surfaces any row whose `user_action IS NULL` as a `vscode.window.showInformationMessage` toast. The plumbing is healthy; the input — `Recommendation` rows being created — is what's intermittent.

The proposed `POST /recommendations/trigger` endpoint plus the **DevVital AI: Trigger Insight** command give a presenter a button to force the popup to appear on demand, with graceful degradation: `real` is honest, `force` is "I know you should fire," `demo` is "the wifi is bad, but the slide must go on."

Constraints:
- No database schema migration. Reuse `workflow_states` and `recommendations`.
- No production hardening. JWT auth is the only gate.
- Bundle entirely inside this one change — no follow-up PRs needed for the demo to work.
- Do not interfere with the scheduler. The scheduler keeps running unchanged.

## Goals / Non-Goals

**Goals:**
- A presenter can produce a popup within a few seconds at any point during the demo.
- The "honest" path is preferred: `real` shows what users actually see; `force` shows "imagine the cooldown isn't blocking us"; `demo` is the last-resort fallback.
- Implementation is small enough to ship the same day.

**Non-Goals:**
- A general-purpose admin tool for manipulating recommendations.
- A way to *suppress* popups (we have cooldown for that).
- Rate limiting / abuse prevention. A logged-in user spamming `demo` mode only floods their own history.
- Telemetry on how often the demo trigger is used.
- Frontend UI to display "this recommendation was triggered manually." Doesn't matter for the demo, and adds scope.
- Replacing the four-rule engine or the LLM prompt. That's `llm-driven-insight-trigger`, a separate change.

## Decisions

### Decision 1: Single endpoint with `mode` field, not three separate endpoints

Why: All three modes share the same auth, the same response shape, the same logging. Splitting them into three URLs trades one POST for three URLs the frontend has to know about. One endpoint with a discriminated body is the standard REST shape for "do one of three related things."

Alternative considered: `POST /recommendations/trigger`, `POST /recommendations/trigger/force`, `POST /recommendations/trigger/demo`. Rejected — more route surface, more docs, no upside.

### Decision 2: `force` does NOT skip the no-rule-fired gate

Why: The point of `force` is to bypass *cooldown*, not to bypass the rules. If we made force always recommend, it would duplicate `demo` and confuse the demo story. Force is "imagine we weren't in cooldown — would a real recommendation fire right now?" If the answer is "no, no rule fires," that's an honest demo signal: the system is working, just doesn't see a reason to interrupt.

Alternative considered: `force` also bypasses the rules and always invokes the LLM. Rejected — see above.

### Decision 3: `demo` mode creates a real `WorkflowState` row

Why: The recommendations controller's `getPending` JOINs `recommendations → workflow_states → sessions`. A `Recommendation` without a `WorkflowState` and `Session` won't surface. We need a row in each table. The cheapest way is `state_type: 'demo'` so it's instantly recognisable as fake when grepping the DB later.

Alternative considered: SQL-insert the recommendation directly with `workflow_state_id` pointing to an existing row. Rejected — coupling to whatever happens to be the latest workflow state is fragile; just create a fresh one.

### Decision 4: Canned demo text is hardcoded, not configurable

Why: Configuration cost vs demo value is wildly imbalanced. A presenter can do one demo with one message. If they need a different message later, edit the constant.

The canned message: `"You've been heads-down for a while. Consider stepping away for 5 minutes — your next bug is probably hiding behind a clear head."` ≤ 240 chars (within the existing Recommendation text limit), second-person, one concrete action, matches the tone of LLM-generated messages.

### Decision 5: Force mode "expires" the latest pending recommendation, not all of them

Why: The cooldown logic in `getLatestRecommendationForUser` looks at the user's single most-recent recommendation, regardless of `user_action`. So we only need to flip the one most-recent row to `expired` to make the cooldown check pass. Going further (expiring all pending rows) is destructive and could mask bugs in the cooldown logic itself.

Alternative considered: temporarily ignore cooldown via a flag passed into `evaluateUser`. Rejected — `evaluateUser` would grow a `{ skipCooldown }` parameter that exists *only* for demo purposes. Worse separation than mutating the one row.

### Decision 6: The extension reuses the existing `RecommendationService` instance

Why: That service already owns the `apiBaseUrl` derivation and the `pollAndNotify` method. Adding a `triggerInsight(mode)` method to it keeps everything related in one file.

Alternative considered: Spawn a new `InsightTriggerService` in the extension. Rejected — strictly more code, no benefit.

### Decision 7: The quick-pick UI, not three palette commands

Why: One palette entry (**DevVital AI: Trigger Insight**) keeps the command list clean. A quick-pick is one extra click during the demo — trivial. Three separate commands would be `triggerInsightReal`, `triggerInsightForce`, `triggerInsightDemo`, which clutters the palette for occasional use.

Alternative considered: status bar item. Rejected for scope — the demo only needs the popup to fire, not a permanent UI surface.

## Risks / Trade-offs

- **Risk:** A user spams `demo` mode and floods their own recommendation history. → **Mitigation:** Document as known limitation. JWT auth means it stays scoped per user. Not exploitable cross-tenant.
- **Risk:** `force` mode races with the scheduler — scheduler tick concurrently calls `evaluateUser` for the same user. → **Mitigation:** The `inFlight` Set in [insight-scheduler.js:21](src/services/insight-scheduler.js#L21) is per-process, but the trigger endpoint runs in the same process as the scheduler. Add the same `inFlight` guard in the controller, or accept duplicate-call possibility and rely on the cooldown query (which now is post-`force`-expire, so it'd see no recent recommendation and proceed). For a hackathon demo, the race is acceptable; document and move on.
- **Risk:** `demo` mode creates a recommendation that bypasses the LLM, so any future audit ("show me Gemini's reasoning") finds `code_context.reasoning` is `null` or a string like `"Demo trigger — no LLM invocation."`. → **Mitigation:** Hardcode `code_context.reasoning = "Manually triggered demo recommendation; no Gemini call was made."`. Self-explanatory in the DB.
- **Risk:** The endpoint exists in production. → **Mitigation:** It's authenticated, no destructive side effects beyond the user's own row. If we later want to disable it in prod, add a single `if (process.env.INSIGHTS_TRIGGER_DEMO_ENABLED === 'false') return 404` guard. Not building that now.
- **Trade-off:** Bundling all three modes in one endpoint means a slightly larger PR surface than just shipping `demo`. Worth it because `real` + `force` exercise the real code path and give us a debugging tool beyond the demo.

## Migration Plan

1. Land the backend changes (route + controller + service helpers + openspec.yaml).
2. Deploy the backend image — no env var changes required.
3. Land the extension changes (package.json + extension.ts + recommendationService.ts).
4. Recompile + reload the extension.
5. Smoke-test the demo flow from the command palette: invoke the command three times, once per mode, verify the popup appears after `demo` and after `force` (assuming a recent recommendation exists for the cooldown bypass to matter), and that `real` either fires or returns a clear `skipped` reason.
6. **Rollback:** revert the backend commit + redeploy. The extension command becomes a no-op (404 → output channel warning). No data cleanup needed; any `state_type = 'demo'` rows are harmless artifacts.

## Open Questions

- Should the canned demo recommendation be visually marked (e.g., prefixed `[Demo]`) in the popup? Trade-off: more honest, less impressive on stage. Decision: leave unmarked for the demo punch; revisit if we keep the trigger long-term.
- Future: should there be an admin-only variant of `force` that lets you target another user's recommendation? Out of scope here, and probably never a good idea.
