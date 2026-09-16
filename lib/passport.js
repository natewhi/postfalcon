import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';

passport.use(
  new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
      const result = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
      const user = result.rows[0];
      // A Google-only account has no password_hash — bcrypt.compare needs a string, so this
      // must be checked before calling it rather than letting it throw. Same "invalid email or
      // password" message either way so login can't be used to probe which accounts exist.
      if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
        return done(null, false, { message: 'invalid email or password' });
      }
      return done(null, { id: user.id, email: user.email });
    } catch (err) {
      return done(err);
    }
  })
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query(
      `SELECT id, email, email_verified_at, created_at, is_admin,
              stripe_customer_id, plan, plan_status, plan_renews_at,
              (password_hash IS NOT NULL) AS has_password,
              (google_id IS NOT NULL) AS has_google
       FROM users WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return done(null, false);
    done(null, result.rows[0]);
  } catch (err) {
    done(err);
  }
});

export default passport;
