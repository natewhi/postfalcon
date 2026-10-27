-- The dashboard's "Get started" checklist and, for admins, the "Finish setting up your server"
-- one (lib/onboarding.js): set when the user closes each, so it stays closed on every device.
-- The steps themselves aren't stored; they're read from the data and the server's settings.
ALTER TABLE users ADD COLUMN onboarding_dismissed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN admin_setup_dismissed_at TIMESTAMPTZ;
