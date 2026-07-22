-- user_id uses ON DELETE SET NULL (not CASCADE) on both tables: this is a security audit
-- trail, so evidence of an account's history (including its own account_deleted event)
-- should survive the account being deleted, not disappear with it.

CREATE TABLE page_visits (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  path TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_page_visits_user_id ON page_visits (user_id);
CREATE INDEX idx_page_visits_created_at ON page_visits (created_at);

CREATE TABLE auth_events (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'login_success',
    'login_failure',
    'logout',
    'signup',
    'password_change',
    'password_reset_request',
    'password_reset_complete',
    'account_deleted',
    'email_verified',
    'api_token_created',
    'api_token_revoked'
  )),
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_auth_events_user_id ON auth_events (user_id);
CREATE INDEX idx_auth_events_created_at ON auth_events (created_at);
CREATE INDEX idx_auth_events_event_type ON auth_events (event_type);
