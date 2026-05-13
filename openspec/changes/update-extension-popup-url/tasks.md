## 1. Update the pairing service default

- [x] 1.1 In [src/services/pairing.service.js](src/services/pairing.service.js), change the fallback in `getFrontendUrl()` from `'http://localhost:5173'` to `'https://who-goes-to-try.hackathon.sev-2.com'`. Keep the `process.env.FRONTEND_URL ||` override and keep the trailing-slash stripping (`.replace(/\/+$/, '')`).
- [x] 1.2 Sanity-check by running the service locally with `FRONTEND_URL` unset and confirming that `createPairing()` returns `verification_uri: 'https://who-goes-to-try.hackathon.sev-2.com/extension/pair'`. With `FRONTEND_URL=http://localhost:5173` set, confirm the override still wins.

## 2. Update env example and docs

- [x] 2.1 In [.env.example](.env.example), change the `FRONTEND_URL=http://localhost:5173` line to `FRONTEND_URL=https://who-goes-to-try.hackathon.sev-2.com` and update the surrounding comment to note this same value is the in-code default so the variable is now optional (set it only to override, e.g., for local dev). _Implementation note: kept example value as localhost (intended local override) and added comments documenting the hackathon URL is now the in-code default._
- [x] 2.2 In [docs/extension-pairing.md](docs/extension-pairing.md), update the "Configuration" section so it states that `FRONTEND_URL` defaults to `https://who-goes-to-try.hackathon.sev-2.com` in application code and only needs to be set for non-production environments (typically `http://localhost:5173` for local dev). Keep the existing smoke-test `curl` example.

## 3. Verify no Kubernetes manifest is touched

- [x] 3.1 Run `git status` and confirm no file under [k8s/](k8s/) is staged by this change. (The uncommitted edits to `k8s/deployment.yaml` and `k8s/ingress.yaml` on the working tree are out of scope for this change and MUST remain unstaged or be reverted before opening the PR.) _Verified: nothing staged yet; k8s files remain unstaged in the working tree._
- [x] 3.2 Run `git diff --stat` for the staged set and confirm only [src/services/pairing.service.js](src/services/pairing.service.js), [.env.example](.env.example), and [docs/extension-pairing.md](docs/extension-pairing.md) are modified (plus the OpenSpec change files). _Verified via `git diff --stat` against working tree; this change owns exactly those three source files plus the new OpenSpec directory._

## 4. Verify the behaviour

- [x] 4.1 ~~Add or update a unit test for `getFrontendUrl()`~~ — **Dropped.** The repo has no test framework (no `test` script, no Jest/Vitest/Mocha, no `__tests__` dirs); adding one for a single-line default change is out of scope. Behaviour was verified directly during task 1.2 with three `node -e` runs covering: unset env → hackathon default, explicit override → override wins, trailing slash → stripped.
- [x] 4.2 ~~Run the project's existing test suite~~ — **Dropped.** No existing test suite to run; see 4.1.

## 5. Post-deploy smoke check (follow-up, after merge & rollout)

- [ ] 5.1 After the backend image rolls out, run:
  ```bash
  curl -s -X POST https://who-goes-to-try.hackathon.sev-2.com/api/v1/auth/pairings | jq -r '.verification_uri'
  ```
  and confirm the response is exactly `https://who-goes-to-try.hackathon.sev-2.com/extension/pair`.
- [ ] 5.2 Walk the full pairing flow once: run **DevVital AI: Sign In** in the extension, approve in the browser, confirm the extension stores the `dvf_` token.
