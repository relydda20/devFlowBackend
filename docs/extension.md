# Extension Integration Runbook

End-to-end verification of the DevVital AI VS Code extension talking to this backend.

## 1. Prerequisites

- Docker running (for Postgres via `docker-compose.yml`).
- `.env` populated with `JWT_SECRET`, DB credentials, etc.
- The `devFlowExtension` sibling repo checked out at `../devFlowExtension`.

## 2. Start the backend

```bash
docker compose up -d postgres
npm install
node src/test-models.js   # one-time: creates tables via sequelize.sync
npm run dev
```

The server listens on `http://localhost:3000`.

## 3. Register a user and capture a JWT

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/register \
     -H 'Content-Type: application/json' \
     -d '{"email":"dev@example.com","password":"correct horse battery staple"}' \
   | tee /tmp/register.json
```

```bash
JWT=$(jq -r .token /tmp/register.json)
```

## 4. Mint an API token

```bash
curl -s -X POST http://localhost:3000/api/v1/auth/tokens \
     -H "Authorization: Bearer $JWT" \
     -H 'Content-Type: application/json' \
     -d '{"name":"Work laptop"}' \
   | tee /tmp/token.json
```

The response includes `token` (prefixed `dvf_…`). **It is shown only once** — copy it.

```bash
DVF=$(jq -r .token /tmp/token.json)
```

## 5. Send a telemetry payload directly (smoke test)

```bash
curl -s -X POST http://localhost:3000/api/v1/telemetry \
     -H "Authorization: Bearer $DVF" \
     -H 'Content-Type: application/json' \
     -d '{
       "workspace": "demo",
       "machine_timestamp": "2026-05-12T10:00:00.000Z",
       "session": {
         "active_minutes": 1,
         "idle_minutes": 0,
         "total_events_collected": 1,
         "save_frequency": 1,
         "editor_switch_frequency": 0
       },
       "events": [{
         "type": "file_save",
         "timestamp": "2026-05-12T10:00:00.000Z",
         "workspace": "demo",
         "session_id": "11111111-1111-4111-8111-111111111111",
         "file": {
           "name": "app.ts",
           "path": "src/app.ts",
           "absolute_path": "/repo/src/app.ts",
           "extension": ".ts",
           "language": "typescript",
           "workspace": "demo",
           "lines": 24,
           "size_bytes": 842
         }
       }]
     }'
```

Expect `HTTP 202` and `{"message":"Telemetry accepted","accepted_count":1}`. Confirm the DB:

```sql
SELECT id, user_id, start_time FROM sessions ORDER BY created_at DESC LIMIT 1;
SELECT event_type, file_path, metadata FROM activities ORDER BY id DESC LIMIT 1;
```

## 6. Drive the extension

1. In `devFlowExtension`: `npm install && npm run compile`.
2. Open the folder in VS Code and press **F5** to launch the Extension Development Host.
3. In the host window, run **DevVital AI: Sign In** and paste `$DVF`.
4. Edit and save any file. Within ~60s the `DevVital AI` output channel should log `Synchronization success`.
5. Verify rows appear in `activities` for that `session_id`.

## 7. Revocation test

```bash
TOKEN_ID=$(jq -r .id /tmp/token.json)
  curl -s -X DELETE http://localhost:3000/api/v1/auth/tokens/$TOKEN_ID \
      -H "Authorization: Bearer $JWT" -o /dev/null -w '%{http_code}\n'
# → 204
```

In VS Code, force a flush (**DevVital AI: Flush Telemetry**). The next sync (or this manual flush) returns 401, the extension clears the cached token from SecretStorage automatically, the sync timer stops, and the status bar flips to `$(circle-slash) DevVital AI: Signed Out`. The flush command surfaces a "Sign in again" notification with a **Sign In** button.

## 8. Sign out manually

Run **DevVital AI: Sign Out** from the command palette (or click the status bar item while signed in). You'll get a modal confirmation; on confirm, the token is cleared locally and the sync timer stops.

**Note:** Sign Out is **local only** — it does not revoke the token on the server. If you want to invalidate the token everywhere (e.g., lost laptop), use `DELETE /api/v1/auth/tokens/:id` as in step 7. The local clear is intentional: it works offline, can't half-fail, and a forgotten-but-server-side-alive token is harmless because no client holds it anymore.

## 9. Re-sign-in

Mint a fresh token (step 4) and run **DevVital AI: Sign In** again. The buffered events collected during the revocation window are flushed on the next sync.

## Notes

- The API token is stored only in VS Code `SecretStorage` (OS keychain). It never appears in `settings.json` or logs.
- Token authentication is accepted on `/telemetry` only. The `/auth/tokens` endpoints require a JWT (so a stolen token cannot mint more tokens).
- `last_used_at` is updated on every successful auth check, fire-and-forget.
- A `401` from the backend triggers an automatic local sign-out in the extension. `5xx` and network errors do not — the timer keeps retrying.
