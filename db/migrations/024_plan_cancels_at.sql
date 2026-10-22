-- When a subscription has been cancelled but runs until the end of the paid period (the
-- billing portal's "cancel at end of billing period"), this is when access stops. NULL when
-- nothing is scheduled to end. Written only by routes/billingWebhook.js, like the other plan_*
-- columns, and shown on the Settings page.
ALTER TABLE users ADD COLUMN plan_cancels_at TIMESTAMPTZ;
