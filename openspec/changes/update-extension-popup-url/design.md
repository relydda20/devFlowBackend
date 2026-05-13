## Context

The VSCode extension pairs with the backend via the device-code flow documented in [docs/extension-pairing.md](docs/extension-pairing.md). The backend's `POST /api/v1/auth/pairings` endpoint returns a `verification_uri` that the extension opens in the user's browser. That URI is built from `FRONTEND_URL` in [src/services/pairing.service.js](src/services/pairing.service.js), with `http://localhost:5173` as the fallback.

The production frontend now lives at `https://who-goes-to-try.hackathon.sev-2.com`. The Kubernetes deployment injects `FRONTEND_URL=https://who-goes-to-try.hackathon.sev-2.com` (the current uncommitted diff on [k8s/deployment.yaml](k8s/deployment.yaml) is doing exactly that). But the user does not want to ship that k8s edit — manifest churn is currently sensitive (TLS, ingress, middlewares are all being reworked in parallel). The application code default should make pairing work correctly even if no env var is set.

Constraints:
- Do not modify any file under [k8s/](k8s/).
- Do not break local development, where `FRONTEND_URL=http://localhost:5173` is already in `.env`.
- The response contract of `POST /api/v1/auth/pairings` must not change shape.

## Goals / Non-Goals

**Goals:**
- The hackathon URL is the effective default for `verification_uri` whenever `FRONTEND_URL` is unset or empty.
- Existing override behaviour via `FRONTEND_URL` is preserved.
- The change is one focused diff in the pairing service plus matching doc/example updates.

**Non-Goals:**
- Changing Kubernetes manifests, ingress, TLS, or middleware config.
- Restructuring the pairing flow, endpoints, or response schema.
- Introducing a new config layer (e.g., a `config/` module) just for one URL.
- Making the frontend or extension aware of the URL — they continue to consume `verification_uri` verbatim from the backend response.

## Decisions

### Decision 1: Change the fallback string in `getFrontendUrl()`

Replace `'http://localhost:5173'` with `'https://who-goes-to-try.hackathon.sev-2.com'` as the fallback inside `getFrontendUrl()` in [src/services/pairing.service.js](src/services/pairing.service.js).

**Rationale:** This is the smallest, most localised change. It keeps the env-var override path untouched and matches what the k8s manifest *would* have injected, so the runtime behaviour with or without the env var is now identical in production.

**Alternative considered:** Introduce a new `PAIRING_VERIFICATION_URL` env var and central config module. Rejected — it adds surface area for a single-string config, and any future deployment that wants to override the host can still do so via `FRONTEND_URL` exactly as it does today.

**Alternative considered:** Hardcode the hackathon URL without honouring `FRONTEND_URL`. Rejected — it would break local development (which depends on `http://localhost:5173`) and remove a useful escape hatch for other environments.

### Decision 2: Also treat an empty `FRONTEND_URL` as "unset"

The current code uses `process.env.FRONTEND_URL || 'http://localhost:5173'`, which already falls back when the value is `''` because of JavaScript truthiness. We preserve that behaviour explicitly in the requirement (see [`Scenario: FRONTEND_URL is set to an empty string`](specs/extension-integration/spec.md)) so a misconfigured pod with an empty env var still gets the safe production default.

**Rationale:** Defensive: an empty env var is a common ops mistake and silently producing `https:///extension/pair` (or worse, leaving the default at localhost) would brick pairing.

### Decision 3: Update `.env.example` and `docs/extension-pairing.md`

`.env.example` becomes a documentation source of truth for new contributors. We change the example value to the hackathon URL and add a comment that the same URL is also the in-code default. `docs/extension-pairing.md` already mentions the hackathon host under "Configuration"; we add a sentence clarifying it is now the application-level default and does not require Kubernetes injection.

**Rationale:** Keep code, example env, and docs in lockstep so the next person reading the docs doesn't wonder why `FRONTEND_URL` is in `.env.example` when "it isn't needed."

### Decision 4: Leave existing tests as the verification surface

Update or add a unit test for `getFrontendUrl()` (and/or `createPairing`) that covers the three scenarios in the spec: unset, set to localhost, and set with a trailing slash. No new test infrastructure is needed.

## Risks / Trade-offs

- **Risk:** Some non-production environment (e.g., a teammate's tunnel-based preview) relied on the old localhost default and never set `FRONTEND_URL`. → **Mitigation:** Anyone running the backend locally already has `FRONTEND_URL=http://localhost:5173` in their `.env` (it's in `.env.example`), and the override path is preserved. We'll call this out in the proposal/PR description.
- **Risk:** The hackathon host changes again before the demo. → **Mitigation:** Future moves are still a one-line code edit plus an env override. Cheap to redo.
- **Risk:** Cluster pods still inject `FRONTEND_URL` at the old localhost value somewhere we missed. → **Mitigation:** Confirm by hitting `POST /api/v1/auth/pairings` on the live host after deploy and asserting `verification_uri` starts with `https://who-goes-to-try.hackathon.sev-2.com`. The doc already shows this smoke-test curl.

## Migration Plan

1. Land the code + doc changes on `develop`.
2. Deploy the backend image normally; no k8s manifest changes accompany the release.
3. Smoke-test from any shell:
   ```bash
   curl -s -X POST https://who-goes-to-try.hackathon.sev-2.com/api/v1/auth/pairings | jq -r '.verification_uri'
   ```
   Expected: `https://who-goes-to-try.hackathon.sev-2.com/extension/pair`.
4. Manually walk the extension pairing flow once end-to-end.
5. **Rollback:** revert the single commit; no data migrations, no infra rollback needed.

## Open Questions

- None. The k8s `FRONTEND_URL` env (currently being added in uncommitted [k8s/deployment.yaml](k8s/deployment.yaml) diff) is intentionally **not** part of this change. If that diff is later committed by a separate change, it becomes a redundant-but-harmless override of the same value.
