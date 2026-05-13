## 1. Backend: service helpers

- [x] 1.1 In [src/services/insight-trigger.service.js](src/services/insight-trigger.service.js), add an exported helper `expireLatestRecommendation(userId)` that marks the user's most recent recommendation with `user_action = 'expired'` (no-op if none exists). Use a single SQL update against `recommendations` joined to `workflow_states` and `sessions`, filtered by `user_id`. Return the number of rows affected.
- [x] 1.2 In the same file, add an exported helper `createDemoRecommendation(userId)` that: (a) loads the user's current session via the existing `getCurrentSessionForUser` (extract from local fn to exported if needed), returns `{ skipped: true, reason: 'no_session' }` when none; (b) inside a single transaction, creates a `WorkflowState` with `state_type = 'demo'`, `confidence_score = 1.0`, `session_id = currentSession.id`; (c) creates a `Recommendation` with `recommendation_type = 'execute'`, hardcoded `recommendation_text` (constant defined at top of file: `"You've been heads-down for a while. Consider stepping away for 5 minutes — your next bug is probably hiding behind a clear head."`), `code_context = { reasoning: 'Manually triggered demo recommendation; no Gemini call was made.', triggered_rule: 'demo_trigger' }`, `user_action = null`; (d) returns `{ skipped: false, mode: 'demo', recommendation_id: <number> }`. _Implementation note: kept `getCurrentSessionForUser` as private and called it directly from `createDemoRecommendation` — no need to export._
- [x] 1.3 Add a `logger.info` line tagged `recommendation-trigger` at the end of `createDemoRecommendation` capturing `user_id` and `recommendation_id`.

## 2. Backend: controller + route

- [x] 2.1 In [src/controllers/recommendations.controller.js](src/controllers/recommendations.controller.js), add `export async function triggerRecommendation(req, res, next)` that: (a) reads `req.body?.mode` defaulting to `'real'`; (b) validates against the set `['real', 'force', 'demo']`, returns HTTP 400 with `{ error: 'Validation failed', message: 'mode must be one of real, force, demo' }` otherwise; (c) dispatches: `real` → `await evaluateUser(req.user.id)`; `force` → `await expireLatestRecommendation(req.user.id); await evaluateUser(req.user.id);`; `demo` → `await createDemoRecommendation(req.user.id)`, returning HTTP 409 with `{ skipped: true, reason: 'no_session' }` when that helper indicates no session; (d) always emits `logger.info('recommendation-trigger', { user_id, mode, outcome })` where `outcome` is the result payload; (e) returns HTTP 200 with the helper's result as JSON.
- [x] 2.2 In [src/routes/recommendations.routes.js](src/routes/recommendations.routes.js), add `router.post('/recommendations/trigger', verifyJwt, triggerRecommendation);` next to the other recommendation routes. Import the new controller export. Do NOT add a `validateRequest` middleware — the controller does the mode validation inline because the openspec body is trivial.

## 3. Backend: openspec.yaml schema entry

- [x] 3.1 In [openspec.yaml](openspec.yaml), add the `POST /recommendations/trigger` path with: `requestBody` referencing a new `TriggerRecommendationRequest` schema (object, properties `mode: { type: string, enum: [real, force, demo] }`, no required fields), `responses` for 200 (returns a free-form `object` with `skipped`, `reason`, `mode`, `rule`, `state_type`, `recommendation_id` all optional), 400 (validation failure), 401 (unauth), 409 (no session for demo). _Implementation note: inlined the request body schema rather than naming it `TriggerRecommendationRequest` under `components.schemas` — the body has one optional property, naming it didn't pay for the indirection._

## 4. Backend: smoke test from a shell

- [ ] 4.1 With the backend running and a known `dvf_` token, run `curl -s -X POST http://localhost:3000/api/v1/recommendations/trigger -H "Authorization: Bearer dvf_…" -H "Content-Type: application/json" -d '{"mode":"demo"}'` and confirm the response is HTTP 200 with `skipped: false, mode: "demo", recommendation_id: <number>`. Then `curl -s http://localhost:3000/api/v1/recommendations/pending -H "Authorization: Bearer dvf_…"` and confirm the demo recommendation is the pending one. _Deferred: requires local backend + valid token; user to run when the backend is up._
- [ ] 4.2 Repeat 4.1 with `{"mode":"force"}` and observe behaviour: if a real recommendation can be produced for the user, it appears; otherwise `{ skipped: true, reason: "no_rule_fired" }` (this is the honest signal — confirms force isn't fabricating). _Deferred: same as 4.1._
- [ ] 4.3 Repeat 4.1 with `{"mode":"real"}` immediately after a successful `force` call and observe `{ skipped: true, reason: "cooldown" }`. This confirms cooldown is still enforced for the real path. _Deferred: same as 4.1._

## 5. Extension: command registration

- [x] 5.1 In [devFlowExtension/package.json](../devFlowExtension/package.json), under `contributes.commands`, add `{ "command": "devvitalAI.triggerInsight", "title": "DevVital AI: Trigger Insight" }`.
- [x] 5.2 In [devFlowExtension/src/services/recommendationService.ts](../devFlowExtension/src/services/recommendationService.ts), add a public method `async triggerInsight(mode: 'real' | 'force' | 'demo'): Promise<void>` that: (a) reads the auth token via `this.auth.getToken()`, returns early with an output-channel warning if absent; (b) POSTs `{ mode }` to `${this.getApiBaseUrl()}/recommendations/trigger` with `Authorization: Bearer <token>`; (c) logs the response status + outcome to the output channel; (d) on success, awaits `this.pollAndNotify()` so the popup appears immediately.
- [x] 5.3 In [devFlowExtension/src/extension.ts](../devFlowExtension/src/extension.ts), register the command in `activate()`:
  ```ts
  context.subscriptions.push(
      vscode.commands.registerCommand('devvitalAI.triggerInsight', async () => {
          const choice = await vscode.window.showQuickPick(
              [
                  { label: 'Real check', detail: 'Runs the real evaluator (respects cooldown).', mode: 'real' as const },
                  { label: 'Force (bypass cooldown)', detail: 'Expires latest pending, then evaluates.', mode: 'force' as const },
                  { label: 'Demo popup', detail: 'Fabricates a canned recommendation. No LLM call.', mode: 'demo' as const },
              ],
              { placeHolder: 'Trigger an insight popup how?' }
          );
          if (!choice) {return;}
          await recommendationService.triggerInsight(choice.mode);
      })
  );
  ```
  Place this near the other `registerCommand` calls in the file.

## 6. Extension: smoke test in the host

- [ ] 6.1 Run `npm run compile` in `devFlowExtension`, reload the VSCode window where the extension runs, open the command palette, and confirm **DevVital AI: Trigger Insight** appears. _Deferred: interactive in the running VSCode host._
- [ ] 6.2 Run the command and select `Demo popup`. Confirm the canned recommendation toast appears within seconds. Click `Dismiss` to verify the action wires through to `POST /recommendations/:id/action`. _Deferred: same as 6.1._
- [ ] 6.3 Run the command and select `Force (bypass cooldown)`. Confirm either a new real recommendation toast appears or the output channel shows `{ skipped: true, reason: '...' }` with a sensible reason. _Deferred: same as 6.1._
- [ ] 6.4 Run the command while signed out (clear the API token via `DevVital AI: Sign Out` first). Confirm a warning appears in the output channel and no network request is made. _Deferred: same as 6.1._

## 7. Docs

- [x] 7.1 In [docs/](docs/), add a short section to whichever recommendations doc exists (or create `docs/recommendations-demo-trigger.md` if none) explaining: the endpoint, the three modes, the extension command name, and the explicit warning that this is a demo-tool escape hatch — not for production use. _Added "Manual trigger" section to `docs/ai-insights.md`._

## 8. Verify no out-of-scope files touched

- [x] 8.1 Run `git status` and confirm modified files are limited to: the OpenSpec change dir, the four backend files (route, controller, service, openspec.yaml), the three extension files (package.json, extension.ts, recommendationService.ts), and the one docs file. No k8s manifest, no migration, no frontend change. _Verified: this change owns 5 backend files (openspec.yaml + 3 src files + docs/ai-insights.md) + the change dir + 3 extension files. Other modified files (.env.example, docs/extension-pairing.md, src/services/pairing.service.js, k8s/*) belong to prior unrelated work and must not be staged with this change._
