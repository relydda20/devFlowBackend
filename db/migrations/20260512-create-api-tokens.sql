CREATE TABLE IF NOT EXISTS api_tokens (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          VARCHAR(64)  NOT NULL,
    token_hash    CHAR(64)     NOT NULL UNIQUE,
    token_prefix  VARCHAR(8)   NOT NULL,
    last_used_at  TIMESTAMPTZ  NULL,
    revoked_at    TIMESTAMPTZ  NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens (user_id);
CREATE INDEX IF NOT EXISTS api_tokens_active_idx  ON api_tokens (user_id) WHERE revoked_at IS NULL;
