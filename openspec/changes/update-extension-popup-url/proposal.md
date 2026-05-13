## Why

Pairing currently builds `verification_uri` from `FRONTEND_URL`, which defaults to `http://localhost:5173`. In environments where that env var is not set (developer laptops, ad-hoc instances, the current cluster pods before redeploy), the extension opens localhost and pairing fails. We want the production hackathon host (`https://who-goes-to-try.hackathon.sev-2.com/extension/pair`) to be the effective default without changing Kubernetes manifests — those have churn we don't want to touch right now.

## What Changes

- Update `getFrontendUrl()` in `src/services/pairing.service.js` so the application code defaults `FRONTEND_URL` to `https://who-goes-to-try.hackathon.sev-2.com` instead of `http://localhost:5173`.
- Keep the `FRONTEND_URL` env var as an override (e.g., local dev can still point to `http://localhost:5173`), so behaviour is unchanged where the env is set.
- Update `.env.example` and `docs/extension-pairing.md` to reflect the new default and clarify that the hackathon URL is now baked in — no k8s change required to make pairing work.
- No edits to `k8s/deployment.yaml`, `k8s/ingress.yaml`, or any other Kubernetes manifest.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `extension-integration`: the verification URI returned by `POST /api/v1/auth/pairings` must default to the hackathon host when `FRONTEND_URL` is unset, instead of localhost.

## Impact

- Affected code: [src/services/pairing.service.js](src/services/pairing.service.js) (`getFrontendUrl` default value).
- Affected docs: [.env.example](.env.example), [docs/extension-pairing.md](docs/extension-pairing.md).
- Tests: any pairing service tests that assert the default URL must be updated.
- No API contract change. The response shape of `POST /api/v1/auth/pairings` is unchanged; only the `verification_uri` value's default origin moves.
- Local dev workflow unchanged when `FRONTEND_URL=http://localhost:5173` is set in `.env`.
- No Kubernetes / infra changes. Existing pods that already inject `FRONTEND_URL` keep working identically.
