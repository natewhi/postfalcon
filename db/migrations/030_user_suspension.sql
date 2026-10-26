-- Set by an admin (Admin -> Customers -> Suspend) to lock an account without deleting it:
-- it can't sign in or use its API token, any session it has stops working, and the scheduler
-- fails its due posts instead of publishing them. NULL = not suspended.
ALTER TABLE users ADD COLUMN suspended_at TIMESTAMPTZ;
