-- Set when a platform rejects an account's credentials (expired/revoked token, changed
-- password) — see lib/reconnect.js. Drives the "Needs reconnecting" prompts in the UI.
ALTER TABLE social_accounts
  ADD COLUMN needs_reconnect_at TIMESTAMPTZ,
  ADD COLUMN reconnect_reason TEXT;

-- New credentials clear the flag automatically: a reconnect (every connect route upserts the
-- row with a fresh access_token) or a successful token refresh. An UPDATE that sets the flag
-- itself is left alone.
CREATE FUNCTION clear_reconnect_on_new_token() RETURNS trigger AS $$
BEGIN
  IF NEW.access_token IS DISTINCT FROM OLD.access_token
     AND NEW.needs_reconnect_at IS NOT DISTINCT FROM OLD.needs_reconnect_at THEN
    NEW.needs_reconnect_at := NULL;
    NEW.reconnect_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER social_accounts_clear_reconnect
  BEFORE UPDATE ON social_accounts
  FOR EACH ROW EXECUTE FUNCTION clear_reconnect_on_new_token();
