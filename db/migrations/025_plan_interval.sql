-- Whether the user's subscription bills monthly or yearly, so the admin overview can estimate
-- monthly revenue (a yearly plan counts as a twelfth of its price per month). Written only by
-- lib/billingSync.js, like the other plan_* columns; NULL until the next webhook or nightly
-- reconciliation for subscriptions that existed before this column.
ALTER TABLE users ADD COLUMN plan_interval TEXT CHECK (plan_interval IN ('monthly', 'yearly'));
