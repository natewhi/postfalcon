import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import app from '../app.js';
import { pool } from '../db/pool.js';

// Stripe SDK is mocked — no network. vi.hoisted so the mock object exists before vi.mock runs.
const { stripeMock } = vi.hoisted(() => ({
  stripeMock: {
    customers: { create: vi.fn(async () => ({ id: 'cus_test_123' })) },
    checkout: { sessions: { create: vi.fn(async () => ({ url: 'https://checkout.stripe.test/s/abc' })) } },
    billingPortal: { sessions: { create: vi.fn(async () => ({ url: 'https://portal.stripe.test/s/xyz' })) } },
    subscriptions: {
      retrieve: vi.fn(),
      list: vi.fn(async () => ({ data: [] })),
      cancel: vi.fn(async (id) => ({ id, status: 'canceled' })),
    },
    webhooks: { constructEvent: vi.fn() },
  },
}));
vi.mock('stripe', () => ({ default: vi.fn(() => stripeMock) }));

beforeAll(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_dummy';
  process.env.STRIPE_PRICE_STANDARD = 'price_standard_dummy';
  process.env.STRIPE_PRICE_PRO = 'price_pro_dummy';
  process.env.STRIPE_PRICE_TEAM = 'price_team_dummy';
  process.env.STRIPE_PRICE_TEAM_YEARLY = 'price_team_yearly_dummy';
  process.env.STRIPE_PRICE_PRO_YEARLY = 'price_pro_yearly_dummy';
});

async function loginNewUser() {
  const client = request.agent(app);
  const email = `bill${Date.now()}${Math.random()}@example.com`;
  await client.post('/api/users').send({ email, password: 'password123' });
  await client.post('/api/auth/login').send({ email, password: 'password123' });
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  return { client, userId: rows[0].id };
}

async function addAccount(client, displayName = '@x') {
  const res = await client.post('/api/v1/social-accounts').send({ platform: 'linkedin', display_name: displayName });
  return res;
}

function futureIso(daysAhead = 1) {
  return new Date(Date.now() + daysAhead * 86400000).toISOString();
}

describe('GET /api/billing/status', () => {
  it('reports a 7-day Standard trial and zero usage for a new user', async () => {
    const { client } = await loginNewUser();
    const res = await client.get('/api/billing/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      plan: 'standard',
      planName: 'Standard',
      planStatus: 'trialing',
      limits: { accounts: 5, scheduledPosts: null },
      usage: { accounts: 0, scheduledPosts: 0 },
    });
    expect(res.body.capabilities).toMatchObject({ crossPosting: true, repeatedPosts: true, webhooks: false });
  });
});

describe('POST /api/billing/checkout', () => {
  it('creates a Stripe Checkout session with a trial and persists the customer id', async () => {
    const { client, userId } = await loginNewUser();
    const res = await client.post('/api/billing/checkout').send({ plan: 'pro' });
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.stripe.test/s/abc');

    const call = stripeMock.checkout.sessions.create.mock.calls.at(-1)[0];
    expect(call.mode).toBe('subscription');
    expect(call.customer).toBe('cus_test_123');
    expect(call.client_reference_id).toBe(String(userId));
    expect(call.line_items[0].price).toBe('price_pro_dummy');
    // A never-subscribed account gets the 7-day trial.
    expect(call.subscription_data).toEqual({ trial_period_days: 7 });

    const { rows } = await pool.query('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);
    expect(rows[0].stripe_customer_id).toBe('cus_test_123');
  });

  it('charges the yearly Price, with the same trial, when interval is yearly', async () => {
    const { client } = await loginNewUser();
    const res = await client.post('/api/billing/checkout').send({ plan: 'team', interval: 'yearly' });
    expect(res.status).toBe(200);
    const call = stripeMock.checkout.sessions.create.mock.calls.at(-1)[0];
    expect(call.line_items[0].price).toBe('price_team_yearly_dummy');
    expect(call.subscription_data).toEqual({ trial_period_days: 7 });
  });

  it('says so when a yearly Price is not configured', async () => {
    const { client } = await loginNewUser();
    const res = await client.post('/api/billing/checkout').send({ plan: 'standard', interval: 'yearly' });
    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/yearly standard/);
  });

  it('still offers the trial after an abandoned Checkout (customer exists, no subscription)', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_abandoned' WHERE id = $1", [userId]);
    stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [] });

    const res = await client.post('/api/billing/checkout').send({ plan: 'standard' });
    expect(res.status).toBe(200);
    expect(stripeMock.subscriptions.list).toHaveBeenLastCalledWith(expect.objectContaining({ customer: 'cus_abandoned' }));
    expect(stripeMock.checkout.sessions.create.mock.calls.at(-1)[0].subscription_data).toEqual({ trial_period_days: 7 });
  });

  it('gives a returning former subscriber no second trial', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_former' WHERE id = $1", [userId]);
    stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [{ id: 'sub_old', status: 'canceled' }] });

    const res = await client.post('/api/billing/checkout').send({ plan: 'pro' });
    expect(res.status).toBe(200);
    expect(stripeMock.checkout.sessions.create.mock.calls.at(-1)[0].subscription_data).toBeUndefined();
  });

  it('refuses a second subscription for someone already subscribed', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_active' WHERE id = $1", [userId]);
    stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [{ id: 'sub_live', status: 'trialing' }] });
    const before = stripeMock.checkout.sessions.create.mock.calls.length;

    const res = await client.post('/api/billing/checkout').send({ plan: 'team' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('already_subscribed');
    expect(stripeMock.checkout.sessions.create.mock.calls.length).toBe(before);
  });

  it('rejects an unknown interval', async () => {
    const { client } = await loginNewUser();
    const res = await client.post('/api/billing/checkout').send({ plan: 'pro', interval: 'weekly' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown plan', async () => {
    const { client } = await loginNewUser();
    const res = await client.post('/api/billing/checkout').send({ plan: 'free' });
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/billing/checkout').send({ plan: 'pro' });
    expect(res.status).toBe(401);
  });
});

describe('plan limits', () => {
  it('blocks connecting more channels than the Standard plan allows', async () => {
    const { client } = await loginNewUser();
    for (let i = 0; i < 5; i++) {
      expect((await addAccount(client, `@ch${i}`)).status).toBe(201);
    }
    const sixth = await addAccount(client, '@ch5');
    expect(sixth.status).toBe(402);
    expect(sixth.body.error).toBe('plan_limit');
  });

  it('gives a Team plan a larger channel cap', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query("UPDATE users SET plan = 'team' WHERE id = $1", [userId]);
    for (let i = 0; i < 6; i++) {
      expect((await addAccount(client, `@team${i}`)).status).toBe(201);
    }
  });

  it('lets any paid plan schedule an unlimited queue', async () => {
    const { client, userId } = await loginNewUser();
    const account = await addAccount(client, '@queue');
    for (let i = 0; i < 15; i++) {
      await pool.query(
        `INSERT INTO posts (user_id, social_account_id, content, status, scheduled_for)
         VALUES ($1, $2, $3, 'scheduled', now() + interval '1 day')`,
        [userId, account.body.id, `queued ${i}`]
      );
    }
    const res = await client
      .post('/api/v1/posts')
      .send({ social_account_id: account.body.id, content: 'still fine', scheduled_for: futureIso() });
    expect(res.status).toBe(201);
  });

  it('locks out mutations once the trial/subscription has lapsed', async () => {
    const { client, userId } = await loginNewUser();
    const account = await addAccount(client, '@lapsed');
    await pool.query("UPDATE users SET plan_status = 'canceled' WHERE id = $1", [userId]);

    const res = await client
      .post('/api/v1/posts')
      .send({ social_account_id: account.body.id, content: 'nope', scheduled_for: futureIso() });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('plan_inactive');
  });

  it('blocks an account that signed up but never finished Checkout', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query("UPDATE users SET plan_status = 'incomplete' WHERE id = $1", [userId]);

    const res = await addAccount(client, '@no-checkout');
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('plan_inactive');
    expect(res.body.message).toMatch(/start your free trial/i);
  });

  it('shows the start-trial banner in the app only until the account can publish', async () => {
    const { client, userId } = await loginNewUser();
    const entitled = await client.get('/dashboard');
    expect(entitled.text).not.toContain('trial-banner');

    await pool.query("UPDATE users SET plan_status = 'incomplete' WHERE id = $1", [userId]);
    const notStarted = await client.get('/dashboard');
    expect(notStarted.text).toContain('Start your 7-day free trial');

    await pool.query("UPDATE users SET plan_status = 'canceled' WHERE id = $1", [userId]);
    const lapsed = await client.get('/accounts');
    expect(lapsed.text).toContain('Your trial or subscription has ended');
  });
});

describe('POST /api/billing/webhook', () => {
  const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;

  it('upgrades the user on checkout.session.completed', async () => {
    const { userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_wh_1' WHERE id = $1", [userId]);
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({
      status: 'active',
      current_period_end: periodEnd,
      items: { data: [{ price: { id: 'price_pro_dummy' } }] },
    });

    const res = await request(app)
      .post('/api/billing/webhook')
      .send({
        id: 'evt_upgrade_1',
        type: 'checkout.session.completed',
        data: { object: { subscription: 'sub_1', customer: 'cus_wh_1', client_reference_id: String(userId) } },
      });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT plan, plan_status, plan_renews_at FROM users WHERE id = $1', [userId]);
    expect(rows[0].plan).toBe('pro');
    expect(rows[0].plan_status).toBe('active');
    expect(rows[0].plan_renews_at).toBeInstanceOf(Date);

    const events = await pool.query('SELECT 1 FROM billing_events WHERE stripe_event_id = $1', ['evt_upgrade_1']);
    expect(events.rows).toHaveLength(1);
  });

  it('ignores a redelivered event', async () => {
    const { userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_wh_2' WHERE id = $1", [userId]);
    stripeMock.subscriptions.retrieve.mockResolvedValueOnce({
      status: 'active',
      current_period_end: periodEnd,
      items: { data: [{ price: { id: 'price_pro_dummy' } }] },
    });
    const payload = {
      id: 'evt_dupe_1',
      type: 'checkout.session.completed',
      data: { object: { subscription: 'sub_2', customer: 'cus_wh_2', client_reference_id: String(userId) } },
    };
    await request(app).post('/api/billing/webhook').send(payload);
    await pool.query("UPDATE users SET plan = 'standard', plan_status = 'active' WHERE id = $1", [userId]);

    const res = await request(app).post('/api/billing/webhook').send(payload);
    expect(res.body.duplicate).toBe(true);
    const { rows } = await pool.query('SELECT plan FROM users WHERE id = $1', [userId]);
    expect(rows[0].plan).toBe('standard'); // not re-applied
  });

  it('recognises a yearly Price, and reads the renewal date from the item (new API versions)', async () => {
    const { userId } = await loginNewUser();
    await pool.query("UPDATE users SET plan = 'standard', stripe_customer_id = 'cus_wh_yearly' WHERE id = $1", [userId]);

    const res = await request(app)
      .post('/api/billing/webhook')
      .send({
        id: 'evt_yearly_1',
        type: 'customer.subscription.updated',
        data: {
          object: {
            customer: 'cus_wh_yearly',
            status: 'trialing',
            // No top-level current_period_end: API versions from 2025-03-31 put it on the item.
            items: { data: [{ price: { id: 'price_pro_yearly_dummy' }, current_period_end: periodEnd }] },
          },
        },
      });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT plan, plan_status, plan_renews_at FROM users WHERE id = $1', [userId]);
    expect(rows[0].plan).toBe('pro');
    expect(rows[0].plan_status).toBe('trialing');
    expect(rows[0].plan_renews_at.getTime()).toBe(periodEnd * 1000);
  });

  it("applies the customer's current subscription, not a stale or older one inside the event", async () => {
    const { userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_order', plan_status = 'active' WHERE id = $1", [userId]);
    // A retried "deleted" event for an old subscription arrives after a newer one started.
    stripeMock.subscriptions.list.mockResolvedValueOnce({
      data: [
        { id: 'sub_old', status: 'canceled', created: 100, items: { data: [{ price: { id: 'price_standard_dummy' } }] } },
        {
          id: 'sub_new',
          status: 'active',
          created: 200,
          items: { data: [{ price: { id: 'price_team_dummy' }, current_period_end: periodEnd }] },
        },
      ],
    });

    await request(app)
      .post('/api/billing/webhook')
      .send({
        id: 'evt_stale_delete',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_old', customer: 'cus_order', status: 'canceled', items: { data: [] } } },
      })
      .expect(200);

    const { rows } = await pool.query('SELECT plan, plan_status FROM users WHERE id = $1', [userId]);
    expect(rows[0]).toEqual({ plan: 'team', plan_status: 'active' });
  });

  it('records when a subscription cancelled at period end will stop', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_cancel_later' WHERE id = $1", [userId]);
    const subscription = {
      id: 'sub_ending',
      customer: 'cus_cancel_later',
      status: 'active',
      created: 1,
      cancel_at_period_end: true,
      items: { data: [{ price: { id: 'price_pro_dummy' }, current_period_end: periodEnd }] },
    };
    stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [subscription] });

    await request(app)
      .post('/api/billing/webhook')
      .send({ id: 'evt_cancel_later', type: 'customer.subscription.updated', data: { object: subscription } })
      .expect(200);

    const { rows } = await pool.query('SELECT plan_status, plan_cancels_at FROM users WHERE id = $1', [userId]);
    expect(rows[0].plan_status).toBe('active'); // still has access until then
    expect(rows[0].plan_cancels_at.getTime()).toBe(periodEnd * 1000);

    const status = await client.get('/api/billing/status');
    expect(new Date(status.body.cancelsAt).getTime()).toBe(periodEnd * 1000);
  });

  it('locks the account once every payment retry has failed (unpaid)', async () => {
    const { userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_unpaid', plan_status = 'past_due' WHERE id = $1", [userId]);
    const subscription = {
      id: 'sub_unpaid',
      customer: 'cus_unpaid',
      status: 'unpaid',
      created: 1,
      items: { data: [{ price: { id: 'price_pro_dummy' } }] },
    };
    stripeMock.subscriptions.list.mockResolvedValueOnce({ data: [subscription] });

    await request(app)
      .post('/api/billing/webhook')
      .send({ id: 'evt_unpaid', type: 'customer.subscription.updated', data: { object: subscription } })
      .expect(200);

    const { rows } = await pool.query('SELECT plan_status FROM users WHERE id = $1', [userId]);
    expect(rows[0].plan_status).toBe('canceled');
  });

  it('locks the account out (keeps last plan) on customer.subscription.deleted', async () => {
    const { userId } = await loginNewUser();
    await pool.query("UPDATE users SET plan = 'pro', plan_status = 'active', stripe_customer_id = 'cus_wh_3' WHERE id = $1", [userId]);

    const res = await request(app)
      .post('/api/billing/webhook')
      .send({
        id: 'evt_cancel_1',
        type: 'customer.subscription.deleted',
        data: {
          object: {
            customer: 'cus_wh_3',
            status: 'canceled',
            current_period_end: periodEnd,
            items: { data: [{ price: { id: 'price_pro_dummy' } }] },
          },
        },
      });
    expect(res.status).toBe(200);

    const { rows } = await pool.query('SELECT plan, plan_status FROM users WHERE id = $1', [userId]);
    expect(rows[0].plan).toBe('pro'); // no free tier — plan sticks, status drives the lockout
    expect(rows[0].plan_status).toBe('canceled');
  });
});

describe('pricing page for a returning visitor', () => {
  it('keeps every plan selectable after an abandoned Checkout', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_abandoned_page', plan_status = 'incomplete' WHERE id = $1", [
      userId,
    ]);
    const res = await client.get('/pricing');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Current plan');
    expect(res.text).toContain('data-plan="standard"');
  });

  it('sends a subscriber to the billing portal to switch plan, not to a new Checkout', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query(
      "UPDATE users SET stripe_customer_id = 'cus_sub_page', plan = 'team', plan_status = 'active' WHERE id = $1",
      [userId]
    );
    const res = await client.get('/pricing');
    expect(res.text).toContain('Current plan');
    expect(res.text).toContain('Switch to Pro');
    expect(res.text).not.toContain('data-plan="pro"');
  });
});

describe('deleting an account with a subscription', () => {
  it('cancels the running subscriptions before deleting the account', async () => {
    const { client, userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_deleting' WHERE id = $1", [userId]);
    stripeMock.subscriptions.list.mockResolvedValueOnce({
      data: [
        { id: 'sub_running', status: 'trialing' },
        { id: 'sub_done', status: 'canceled' },
      ],
    });
    stripeMock.subscriptions.cancel.mockClear();

    const res = await client.post('/api/auth/delete-account').send({ password: 'password123' });
    expect(res.status).toBeLessThan(300);
    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripeMock.subscriptions.cancel).toHaveBeenCalledWith('sub_running');
    const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    expect(rows).toHaveLength(0);
  });

  it("keeps the account if Stripe can't cancel the subscription", async () => {
    const { client, userId } = await loginNewUser();
    await pool.query("UPDATE users SET stripe_customer_id = 'cus_stripe_down' WHERE id = $1", [userId]);
    stripeMock.subscriptions.list.mockRejectedValueOnce(new Error('Stripe is down'));

    const res = await client.post('/api/auth/delete-account').send({ password: 'password123' });
    expect(res.status).toBe(503);
    const { rows } = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    expect(rows).toHaveLength(1);
  });
});
