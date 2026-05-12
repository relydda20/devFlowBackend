## ADDED Requirements

### Requirement: Health endpoint responds with 200
The system SHALL expose `GET /api/v1/health` that returns HTTP `200` with a JSON body `{ "status": "ok" }`.

#### Scenario: Server is running
- **WHEN** a client sends `GET /api/v1/health`
- **THEN** the response is HTTP `200`, `Content-Type` is `application/json`, and the body parses to `{ status: "ok" }`

### Requirement: Health endpoint performs no I/O
The system SHALL serve the health endpoint without performing any database, network, or filesystem I/O, so that liveness is reported independently of dependency state.

#### Scenario: Database is unreachable
- **WHEN** the database connection is down and a client sends `GET /api/v1/health`
- **THEN** the response is still HTTP `200` with `{ status: "ok" }`

### Requirement: Health endpoint requires no authentication
The system SHALL accept `GET /api/v1/health` without authentication headers, cookies, or tokens.

#### Scenario: Anonymous request
- **WHEN** a client sends `GET /api/v1/health` with no auth headers
- **THEN** the response is HTTP `200` and no auth challenge is returned
