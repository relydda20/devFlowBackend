## Context

Three pieces of infrastructure already exist that this change builds on:

- The `metrics-etl` pipeline ([src/services/metrics-etl.service.js](src/services/metrics-etl.service.js)) produces `metrics_daily` and `metrics_session` rows on a 5-minute cadence. Today's churn, switching, and top files are a single indexed query away.
- The `workflow_states` and `recommendations` tables already exist with appropriate columns (`state_type`, `confidence_score`, `recommendation_type`, `recommendation_text`, `user_action`, `outcome_improved`).
- [openspec.yaml](openspec.yaml) already declares the canonical enums: `state_type ∈ { stuck_loop, lost_in_codebase, ai_dependency_trap, integration_hell, analysis_paralysis, normal }` and `recommendation_type ∈ { change_approach, map_system, stop_using_ai, simplify_problem, execute }`.

What's missing: anything that actually populates those tables, anything that calls an LLM, and any UI surface for users to see or act on the result. The dashboard's "AI Insights" card and the extension's `Take a Break` button were placeholders.

The user's request has two halves that look like one feature but are architecturally distinct:

1. **The insight pipeline** — a background process that decides "this user looks stuck" and asks Gemini to characterize and recommend.
2. **The delivery channels** — dashboard panel and extension popup, both reading from the same recommendations table.

Both halves must work for either to be useful, but they're decoupled by the table. The pipeline only writes; the UIs only read and record actions.

## Goals / Non-Goals

**Goals:**
- Deterministic, cost-bounded LLM usage. Every call corresponds to a threshold-triggered candidate moment; no constant polling of the LLM.
- A user-controllable feedback loop: every recommendation tracks accepted / dismissed / snoozed, so we can later analyze "are our suggestions any good?"
- Honest UI: pending and acted-on states are visually distinct on the dashboard. The extension popup never lies about the state of the data.
- Backwards-compatible failure: if Gemini is down or `GOOGLE_API_KEY` is unset, the rest of the system keeps working. No metrics card breaks; the extension's telemetry sync continues; the dashboard's existing cards render normally.

**Non-Goals:**
- "AI judge whether the recommendation worked." That requires longitudinal tracking of metrics-after-recommendation vs metrics-before, which is a separate change. We capture `user_action` now and leave `outcome_improved` nullable.
- Real-time delivery (SSE / WebSocket). Polling on the extension's existing sync timer is sufficient; the worst-case latency is one sync interval (default 60s), which is fine for "consider taking a break" UX.
- A settings UI for thresholds. They're env vars in this change; we lift them to per-user settings when there's evidence different users need different sensitivities.
- Multi-recommendation queueing. At most one pending recommendation exists per user at any time. If a new one is generated while an old one is unacted, the old one is auto-marked `expired` and replaced.
- Embedding-based memory or RAG. We send the LLM a small, fully-known set of numbers; we don't need vector search.
- OpenAI / Anthropic provider support. Gemini only for v1.

## Decisions

### Threshold rules gate the LLM; the LLM judges the candidate

The insight pipeline runs on two stages:

1. **Rule engine** (cheap, runs every 10 minutes per active user). Reads the user's recent metrics + current session and decides whether ANY of these is true:
   - Session length > 2 hours AND churn ratio today > 0.4.
   - Switch count in the last hour > 30 (rapid context-switching window).
   - Lines deleted today > lines added today AND total > 50 (rewriting, not building).
   - Active session has zero saves in the last 30 minutes despite non-zero text_change events (typing into nothing).
   - Session length > 4 hours regardless of other signals (mandatory-break candidate).
2. **LLM call** (one per candidate moment). The rule engine builds a small JSON object with the relevant numbers + top files + which rule triggered, asks Gemini to either confirm + characterize + recommend, OR explicitly return `{ state_type: "normal", confidence_score: <low> }` if it disagrees.

**Why two stages instead of "let the LLM decide every 10 minutes":**
- Cost. Most ticks see nothing interesting. Calling the LLM for every "nothing interesting" tick is paying for silence.
- Predictability. The rules are auditable: "we asked Gemini because rule X fired." If a user complains about a popup at the wrong moment, we can trace it.
- The LLM still has a vote — it can disagree by returning `state_type: "normal"`, which we treat as "rule was a false positive, don't surface."

**Alternative considered:** ML model trained on labeled data. Rejected — we have no labels yet. The rules + LLM-as-judge architecture is the bootstrap path that *produces* the labels (via `user_action`) we'd later use to train.

### LLM output is strict JSON with a JSON-mode prompt

Gemini supports `responseMimeType: "application/json"`. We use it. The prompt instructs the model to respond with exactly:

```json
{
  "state_type": "<one of the 6 enum values>",
  "confidence_score": 0.0,
  "recommendation_type": "<one of the 5 enum values>",
  "recommendation_text": "<<= 240 chars, second-person, single concrete action>",
  "reasoning": "<<= 600 chars, plain prose>"
}
```

Validation happens server-side via AJV against a JSON Schema. If the response fails validation OR can't be parsed, we log + count it as a transient LLM failure and DO NOT persist a row. The next tick re-evaluates.

**Why strict JSON + validation:** the LLM is famously inconsistent if you let it. The dashboard and the extension need to render distinct UI per `state_type`; we cannot accept `"state_type": "stuck loop"` or `"workflow_state": "..."`. Strict structure + a hard validation gate keeps the contract.

**Alternative considered:** Free-form text rendered verbatim. Rejected — see the "Output shape" question we asked the user. Free-form makes the feedback loop and UI faceting impossible.

### One pending recommendation per user at a time

The pipeline maintains an invariant: a user has at most one un-acted recommendation. When a new one is generated, any prior un-acted recommendations for that user are marked `expired` (via a new value in `user_action`) before the new one is inserted.

**Why:** the extension popup is interruptive. Stacking popups would be hostile. The dashboard panel can still show *all* historical recommendations (acted and expired), so nothing is lost — just the "what should I do RIGHT NOW" pointer is single-valued.

### Cooldown and snooze enforce gaps between recommendations

After firing a recommendation for a user, the rule engine ignores that user for `INSIGHT_COOLDOWN_MINUTES` (default 45). If the user clicks **Snooze 30m**, the cooldown is replaced by a 30-minute snooze starting from the action time. Cooldown and snooze are stored implicitly as `MAX(recommendations.created_at) WHERE user_id = ? AND user_action != 'snoozed'` vs `WHERE user_action = 'snoozed'`; no separate state.

**Why store implicitly instead of a `next_check_at` column:** simpler. The query is cheap. The trigger engine already needs to read the latest recommendation to maintain the "one pending" invariant.

### LLM is hidden behind a tiny adapter, but we don't build a full provider abstraction

`src/services/llm/gemini.service.js` exports `generateInsight({ metrics, session, topFiles, triggeredRule }): Promise<StructuredInsight>`. That's the entire abstraction. There is NO `LLMProvider` interface today.

**Why:** the user asked for Gemini specifically. A provider abstraction now costs LOC and adds a layer of indirection for a swap we may never make. If we ever switch, replacing the contents of one file is mechanical.

**Alternative considered:** Full strategy pattern with `OpenAIProvider`, `AnthropicProvider`, etc. Rejected as YAGNI. Documented for future-us in case priorities change.

### Pending-recommendation endpoint is auth-token-friendly

The extension polls `GET /api/v1/recommendations/pending` using its `dvf_` API token. The middleware accepts both API tokens and JWTs (per existing [auth.middleware.js](src/middleware/auth.middleware.js)). The endpoint is keyed on `req.user.id`, so an API token gets the right user's data.

The action endpoint (`POST /:id/action`) accepts either auth method too; the action is scoped to the recommendation owner.

### Insight scheduler is in-process, like the ETL scheduler

We add `INSIGHTS_ENABLED` (default `true`, can be set to `false` to disable in dev). The scheduler starts in [server.js](src/server.js) alongside the metrics ETL scheduler. SIGTERM/SIGINT stop both.

**Why in-process:** we already have one scheduler living happily. Adding another follows the same pattern. A separate worker would be premature optimization for a feature that calls the LLM at most ~6 times per active user per hour worst-case.

**Concurrency:** the scheduler keeps a Set of "users currently being evaluated" to avoid two tickers racing on the same user (rare but possible if the tick is slow or the LLM is slow). The set is in-memory, single-process; this works because we run one backend replica.

### Extension popup uses information-message, not modal

`vscode.window.showInformationMessage` with three action buttons. NON-modal. Users coding deep don't have their flow interrupted by a popup that demands attention; the message sits in the corner and they engage when ready.

The extension tracks the last-shown recommendation id in memory and skips re-showing the same one. If the user dismisses the toast without clicking an action button, the recommendation remains `pending` server-side and will be shown again on the next poll cycle — until the user explicitly acts. We document this trade-off; it's the "you can't accidentally make it go away" guarantee.

## Risks / Trade-offs

- **[Risk] Gemini returns valid JSON but a hallucinated `state_type` not in the enum** → AJV validation rejects, no row written, no popup. The user sees no alert for that tick. We log so we can monitor false-positive rate.
- **[Risk] A user gets a popup at a genuinely bad moment (giving a demo, screen-sharing)** → Snooze button + non-modal toast. The popup degrades to an inline corner notification; the user can ignore it.
- **[Risk] The threshold rules are wrong and fire too often / not enough** → Adjustable via env vars and well-documented; we treat the initial defaults as starting points and tune from real data. The `confidence_score` from the LLM gives us a fallback to filter: a future change could suppress alerts with `confidence_score < 0.6`.
- **[Risk] Gemini API outage** → `generateInsight` throws; rule engine logs and skips; next tick retries. No user-facing visible failure. The dashboard's existing data continues to render.
- **[Risk] `GOOGLE_API_KEY` is leaked via logs** → The Gemini service module never logs the key. Standard secret-handling. The key is read once at module load and stored in a closure.
- **[Trade-off] No provider abstraction means a future Anthropic / OpenAI swap is a rewrite of one file** → Acceptable. The file is ~80 lines.
- **[Trade-off] Polling every 60s on the extension means up to 60s delay before the popup appears** → Fine for "consider a break" UX. Real-time delivery isn't required.
- **[Trade-off] The cost model assumes Flash pricing. If Google changes pricing or we move to Pro, costs scale** → The `INSIGHT_CHECK_INTERVAL_SECONDS` env var lets us reduce frequency without code changes.
- **[Risk] The LLM prompt could be reverse-engineered or leaked** → Acceptable. The prompt contains no secrets; it's just "here are some workflow numbers, advise."
- **[Risk] Per-user concurrency Set is process-local; if we ever scale to multiple backend replicas, two replicas could both fire for the same user** → Document as a known limitation. Mitigation later: a `recommendations` row's `(user_id, created_at)` uniqueness within a 5-minute window, enforced at insert time.
- **[Risk] The LLM costs money even when no human is looking at the dashboard** → The trigger runs only for "active users" (users with telemetry events in the last `INSIGHT_ACTIVITY_WINDOW_MINUTES`, default 30). Idle users don't generate calls.
