-- A fresh install has no way to make anyone an admin without SQL. The very first account
-- created (users table empty) becomes the admin, on the top plan with no Stripe subscription:
-- it's the operator's own instance. Covers every way an account is created (email signup and
-- Sign in with Google) since it's on the table. Existing installs already have users, so
-- this changes nothing for them. Further admins are granted from Admin -> Customers.
CREATE FUNCTION first_user_is_admin() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users) THEN
    NEW.is_admin := true;
    NEW.plan := 'pro';
    NEW.plan_status := 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER first_user_is_admin
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION first_user_is_admin();
