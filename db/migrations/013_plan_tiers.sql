-- Move off the Free/Pro/Team tiers to three paid plans (Standard / Team / Pro) with a trial.
-- New accounts start on a 7-day trial of Standard; enforcement treats plan_status
-- 'trialing' as entitled (see lib/billing.js isEntitled).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_plan_check;

-- Carry pre-existing rows onto the new scale before re-adding the constraint.
UPDATE users SET plan = 'standard' WHERE plan NOT IN ('standard', 'team', 'pro');

ALTER TABLE users ALTER COLUMN plan SET DEFAULT 'standard';
ALTER TABLE users ALTER COLUMN plan_status SET DEFAULT 'trialing';

ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('standard', 'team', 'pro'));
