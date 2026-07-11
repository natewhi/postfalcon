ALTER TABLE social_accounts ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE mastodon_apps (
  instance TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
