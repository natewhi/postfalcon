CREATE TABLE api_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX idx_api_tokens_token_hash ON api_tokens (token_hash);
CREATE INDEX idx_api_tokens_user_id ON api_tokens (user_id);
