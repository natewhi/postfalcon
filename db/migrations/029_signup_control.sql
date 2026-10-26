-- Who may create an account, set by an admin from Admin -> Customers instead of in code or SQL.
-- instance_settings holds instance-wide settings, one row per key ('signup_mode' for now:
-- 'open' | 'invite' | 'closed'; no row = 'open'). invites are one-time signup links: only the
-- token's hash is stored, the link itself is shown once when it's created.
CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE invites (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  note TEXT,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
