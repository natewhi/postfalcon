-- Error-level log lines (lib/logger.js hook -> lib/errorLog.js), so an admin can see what went
-- wrong from Admin -> Activity without the server's logs. Pruned after 30 days.
CREATE TABLE server_errors (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message TEXT,
  error_type TEXT,
  error_message TEXT,
  stack TEXT,
  method TEXT,
  url TEXT
);
CREATE INDEX idx_server_errors_created_at ON server_errors (created_at);

-- Problems lib/alerts.js has emailed admins about, one row per kind of problem (key), so each
-- is announced once when it starts, reminded daily while it lasts, and reported when it clears.
CREATE TABLE admin_alerts (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT,
  active_since TIMESTAMPTZ NOT NULL,
  notified_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);
