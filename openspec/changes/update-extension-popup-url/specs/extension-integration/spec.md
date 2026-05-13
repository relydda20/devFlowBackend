## ADDED Requirements

### Requirement: Pairing verification URI defaults to the hackathon host

The pairing service SHALL build the `verification_uri` returned by `POST /api/v1/auth/pairings` from a frontend origin that defaults to `https://who-goes-to-try.hackathon.sev-2.com` when the `FRONTEND_URL` environment variable is unset or empty. The system SHALL continue to honour `FRONTEND_URL` as an override when it is set to a non-empty value, and SHALL trim trailing slashes from the resolved origin before appending `/extension/pair`.

#### Scenario: FRONTEND_URL is unset in production-like environments

- **WHEN** the backend process starts with no `FRONTEND_URL` set and the extension calls `POST /api/v1/auth/pairings`
- **THEN** the response `verification_uri` SHALL equal `https://who-goes-to-try.hackathon.sev-2.com/extension/pair`

#### Scenario: FRONTEND_URL override is honoured for local development

- **WHEN** the backend process starts with `FRONTEND_URL=http://localhost:5173` and the extension calls `POST /api/v1/auth/pairings`
- **THEN** the response `verification_uri` SHALL equal `http://localhost:5173/extension/pair`

#### Scenario: FRONTEND_URL with a trailing slash is normalised

- **WHEN** the backend process starts with `FRONTEND_URL=https://who-goes-to-try.hackathon.sev-2.com/` (with a trailing slash) and the extension calls `POST /api/v1/auth/pairings`
- **THEN** the response `verification_uri` SHALL equal `https://who-goes-to-try.hackathon.sev-2.com/extension/pair` (no duplicate slash)

#### Scenario: FRONTEND_URL is set to an empty string

- **WHEN** the backend process starts with `FRONTEND_URL=""` and the extension calls `POST /api/v1/auth/pairings`
- **THEN** the response `verification_uri` SHALL equal `https://who-goes-to-try.hackathon.sev-2.com/extension/pair` (empty value falls back to the hackathon default)
