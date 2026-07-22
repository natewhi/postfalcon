-- No self-serve promotion flow — grant with:
--   UPDATE users SET is_admin = true WHERE email = 'you@example.com';
ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;
