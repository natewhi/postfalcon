-- Billing: Stripe subscription state denormalized onto users (Stripe stays the system of
-- record; these columns are the app's read-fast copy, updated by the webhook handler).
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT UNIQUE;
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free'
  CHECK (plan IN ('free', 'pro', 'team'));
ALTER TABLE users ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'active'
  CHECK (plan_status IN ('active', 'trialing', 'past_due', 'canceled', 'incomplete'));
ALTER TABLE users ADD COLUMN plan_renews_at TIMESTAMPTZ;

-- One row per processed Stripe webhook event, for idempotency — Stripe redelivers events
-- and the handler must not apply one twice.
CREATE TABLE billing_events (
  stripe_event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
