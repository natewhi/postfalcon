# Setting up analytics (self-hosted Umami)

Postfalcon's own `page_visits`/`product_events` tables are in-app usage analytics (who did what
inside the product). They deliberately don't capture referrers, anonymous-visitor sessions, or
give you a reporting dashboard — that's not what they're for. For traffic/SEO reporting
(where visitors come from, which pages/blog posts drive signups, trends over time), run
[Umami](https://umami.is) alongside Postfalcon and let it handle that instead of trying to extend
the internal tables into something they're not.

The Postfalcon side is already built and does nothing until you configure it:
`routes/analytics.js` reverse-proxies `/stats/*` to your Umami instance (so the tracking
script and its data both stay same-origin — no CSP changes, and ad blockers that target known
analytics domains don't recognise it), and `views/partials/analytics.ejs` only emits the
`<script>` tag when `UMAMI_WEBSITE_ID` is set. Everything below is a **production-VPS-only**
setup step, done outside this repo — none of it runs on devbox03 (the dev VM). Leave
`UMAMI_HOST`/`UMAMI_WEBSITE_ID` unset in dev/`.env.test`; analytics just no-ops (`/stats/*`
404s, no `<script>` tag renders) until they're set, which is the expected state there.

## 1. Give Umami its own database

Umami needs its own Postgres database — don't point it at the `postfalcon` database.

```bash
sudo -u postgres createdb umami
```

(Reuse the same Postgres server/role Postfalcon already uses; it's just a separate database.)

## 2. Install and build Umami

```bash
git clone https://github.com/umami-software/umami.git
cd umami
npm install
```

Create `umami/.env` with:

```
DATABASE_URL=postgresql://postgres:<password>@localhost:5432/umami
APP_SECRET=<a long random string>
```

Then run Umami's own build (this also applies its database migrations):

```bash
npm run build
```

## 3. Run it under pm2, on a port Postfalcon never uses

```bash
pm2 start npm --name umami --cwd /path/to/umami -- start -- -p 3002
pm2 save
```

Port `3002` is arbitrary — just make sure it doesn't collide with Postfalcon's own `PORT`
(`.env.example` default `3000`) or the test server's `PORT` (`.env.test`, `3001`).

Umami does **not** need a public Caddy site or a DNS record — no public-facing hostname is
involved anywhere in this setup. It listens on all interfaces by default, which is fine: step 5
locks down *which* interfaces can actually reach it with a firewall rule, rather than a domain
or reverse proxy.

## 4. Point Postfalcon at it

In Postfalcon's `.env` on the VPS:

```
UMAMI_HOST=http://localhost:3002
```

`pm2 reload postfalcon` to pick it up. At this point `/stats/script.js` should return Umami's
tracking script through Postfalcon's own domain — but no page emits it yet, because
`UMAMI_WEBSITE_ID` isn't set.

## 5. Restrict Umami's dashboard to the OpenVPN interface

The goal: Postfalcon (on the same box) keeps reaching Umami over `localhost` regardless of any
firewall change; your browser, over the VPN, reaches it at the VPS's tunnel IP; the public
internet gets nothing on that port at all. That means Umami itself can stay listening on all
interfaces (step 3) — a firewall rule is what actually restricts who can connect.

First, find the VPN tunnel interface and the IP the VPS holds on it (typically `tun0`, an
address like `10.8.0.x`, but confirm rather than assume):

```bash
ip a | grep -A2 tun
```

Then, with `ufw` (adjust the interface name if yours isn't `tun0`):

```bash
sudo ufw deny 3002                          # block it by default, including the public interface
sudo ufw allow from 127.0.0.1 to any port 3002   # Postfalcon's own /stats proxy (same machine)
sudo ufw allow in on tun0 to any port 3002        # your browser, over the VPN
sudo ufw reload
```

Confirm it worked: `curl http://<vps-public-ip>:3002` should hang/refuse from outside the VPN,
while `curl http://localhost:3002` on the VPS itself, and `http://<vps-tunnel-ip>:3002` from a
machine connected to the VPN, should both return Umami's login page.

Once that's confirmed, connect to the OpenVPN and open `http://<vps-tunnel-ip>:3002` in your
browser. Log in (Umami's setup wizard creates the first admin account on first visit), add a
website with Postfalcon's real public domain, and copy the **Website ID** it generates (a UUID).

## 6. Turn tracking on

Back in Postfalcon's `.env`:

```
UMAMI_WEBSITE_ID=<the uuid from step 5>
```

`pm2 reload postfalcon`. Visit the live site, then check Umami's dashboard — the pageview should
show up within a few seconds.

## What's tracked

The `<%- include('partials/analytics') %>` tag is on every public/marketing page — landing,
pricing, blog (index + posts), API docs, the auth pages (login/signup/forgot/reset), and 404
(404s are worth watching: they can point at broken backlinks worth fixing). It's deliberately
**not** on the authenticated app (`/dashboard`, `/accounts`, `/settings`, `/admin`) — that
usage is already covered by `product_events`, and there's no reason to run a second tracker
over a logged-in user's day-to-day work.

## Also do this regardless of Umami

Submit `https://yourdomain.com/sitemap.xml` to
[Google Search Console](https://search.google.com/search-console) — it's free, and it's the
only source for which queries you actually rank for, impressions, and indexing issues. Umami
tells you what happens after someone clicks; Search Console tells you whether Google is
finding you in the first place.
