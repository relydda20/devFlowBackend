# Extension Pairing Endpoints

Device-code pairing lets the VSCode extension obtain a `dvf_` API token by piggybacking on a logged-in browser session. The flow is similar to RFC 8628 (OAuth 2.0 Device Authorization Grant).

## Flow

1. Extension calls `POST /api/v1/auth/pairings` and receives a `pairing_id`, `user_code`, and `verification_uri`.
2. Extension opens `<verification_uri>?code=<user_code>` in the user's browser and starts polling `POST /api/v1/auth/pairings/<pairing_id>/exchange` every 2 seconds.
3. User (logged into the frontend) clicks **Approve** on the pairing page. The frontend calls `POST /api/v1/auth/pairings/<user_code>/approve` with credentials.
4. The next exchange poll returns `{ status: "approved", token: "dvf_..." }`. The extension stores the token in `SecretStorage`.

## Endpoints

### `POST /api/v1/auth/pairings`

No authentication. Creates a pending pairing row.

**Response 201:**
```json
{
  "pairing_id": "uuid",
  "user_code": "BRWN-4F2X",
  "verification_uri": "https://frontend.example.com/extension/pair",
  "expires_in": 600
}
```

The `user_code` uses the unambiguous alphabet `BCDFGHJKMNPQRSTVWXZ23456789` (no vowels, no `0/O/1/I/l`).

### `POST /api/v1/auth/pairings/:user_code/approve`

Requires JWT (cookie or `Authorization: Bearer`). API tokens cannot approve.

**Response 200:** `{ "ok": true }`

**Errors:**
- `401` — no JWT
- `403` — authenticated with an API token rather than a JWT
- `404` — `user_code` does not match any pairing
- `409` — pairing already approved/consumed
- `410` — pairing expired (row is deleted)

Approving mints a `dvf_` token named `VSCode (paired YYYY-MM-DD)` against the JWT subject and stores its plaintext on the pairing row until the next successful exchange.

### `POST /api/v1/auth/pairings/:pairing_id/exchange`

No authentication. Rate-limited to one request per second per `pairing_id`.

**Response 200:**
- `{ "status": "pending" }` — keep polling
- `{ "status": "approved", "token": "dvf_..." }` — token delivered exactly once; row transitions to `consumed`
- `{ "status": "consumed" }` — token already delivered

**Response 410:** `{ "status": "expired" }` — row missing or `expires_at < NOW()`

**Response 429:** `{ "error": "Too many requests" }`

## Configuration

The backend builds `verification_uri` from `FRONTEND_URL`. In application code this defaults to `https://who-goes-to-try.hackathon.sev-2.com`, so production pods do not need to inject the variable to get the right pairing URL. Set `FRONTEND_URL` only when you need to override the default — typically `http://localhost:5173` for local development.

```env
# Local development override
FRONTEND_URL=http://localhost:5173
```

After rollout, smoke-test the public pairing URL:

```bash
curl -s -X POST https://who-goes-to-try.hackathon.sev-2.com/api/v1/auth/pairings \
  | jq -r '.verification_uri'
```

Expected output:

```text
https://who-goes-to-try.hackathon.sev-2.com/extension/pair
```

Expired rows are pruned every 5 minutes (`pairing.service.js#cleanupExpired`); the cleanup removes rows whose `expires_at` is more than one hour in the past so a slow extension still finds its row.
