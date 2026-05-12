## MODIFIED Requirements

### Requirement: JWT issuance and claims
The system SHALL mint JWTs signed with `JWT_SECRET` (HS256) containing `sub` (User UUID), `provider`, `iat`, and `exp` claims.

#### Scenario: Token decodes to expected claims
- **WHEN** a JWT issued by any auth flow is decoded
- **THEN** it contains `sub` (matching the User's UUID), `provider` (one of `google`, `github`, or `password`), `iat` (issued-at timestamp), and `exp` (expiry timestamp, no more than 7 days after `iat`)
