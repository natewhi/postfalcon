-- Per-platform on/off switches set from the admin Platforms page (routes/admin.js). A platform
-- with no row keeps its default from lib/platforms.js (enabled unless `unlisted`).
CREATE TABLE platform_settings (
  platform TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
