-- New accounts used to default to plan_status 'trialing' (migration 013), and only the Stripe
-- webhook ever changes it — so signing up and closing the Checkout tab meant a trial that never
-- ended. Start new accounts 'incomplete' instead (not entitled, see lib/billing.js isEntitled);
-- routes/billingWebhook.js sets the real status ('trialing' / 'active') once Checkout completes.
ALTER TABLE users ALTER COLUMN plan_status SET DEFAULT 'incomplete';

-- Existing accounts that never reached Checkout get the same treatment. Admins, and accounts
-- set to 'active' by hand (e.g. a platform-review test login), are left alone.
UPDATE users
   SET plan_status = 'incomplete'
 WHERE stripe_customer_id IS NULL
   AND plan_status = 'trialing'
   AND NOT is_admin;
