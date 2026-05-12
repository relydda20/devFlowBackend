CREATE TABLE IF NOT EXISTS pairing_codes (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    user_code        VARCHAR(9)   NOT NULL,
    status           VARCHAR(16)  NOT NULL DEFAULT 'pending',
    user_id          UUID         NULL REFERENCES users(id) ON DELETE CASCADE,
    api_token_id     UUID         NULL REFERENCES api_tokens(id) ON DELETE SET NULL,
    token_plaintext  TEXT         NULL,
    expires_at       TIMESTAMPTZ  NOT NULL,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT pairing_codes_status_check CHECK (status IN ('pending', 'approved', 'consumed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS pairing_codes_user_code_pending_idx
    ON pairing_codes (user_code) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS pairing_codes_user_code_idx ON pairing_codes (user_code);
CREATE INDEX IF NOT EXISTS pairing_codes_expires_at_idx ON pairing_codes (expires_at);
