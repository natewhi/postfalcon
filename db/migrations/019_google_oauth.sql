-- Google sign-in: an account created this way has no password of its own, and an existing
-- password account can later link a google_id (matched by email at first Google sign-in).
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE;
