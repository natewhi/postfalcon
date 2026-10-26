# Postfalcon

Social media post scheduler. Node.js/Express backend, Postgres, EJS server-rendered views, vanilla JS on the
frontend (no framework, no bundler). Users connect social accounts (live: Mastodon, Bluesky, Facebook, Instagram,
Threads, Telegram, YouTube, TikTok, Pinterest, LinkedIn — LinkedIn is still `unlisted` in the registry, i.e. off by
default, and was switched on in prod from Admin → Platforms once its developer app existed; built but `unlisted` and
not offered anywhere yet: X under the id `x` (`lib/platforms/x.js` + `routes/x.js`, OAuth 2.0 PKCE, text +
up to 4 images; unlisted until there's an X app on a paid API plan, since X charges for posting). The old `twitter`
id is a separate never-offered placeholder the test suite uses as its generic stub — don't repurpose it. Hidden stubs,
no adapter yet: Reddit, Google Business Profile — see `lib/platforms.js`). Deliberately out of scope: messaging apps
(WhatsApp, WeChat, Messenger) — Postfalcon schedules social *posts*, not chat messages, and none of them have a
public feed to publish to. Users compose posts as drafts or schedule them, and a per-minute cron job publishes due
posts.
A post can target several channels at once (cross-posting) and can recur (daily/weekly/monthly). There is no
free tier: every account is on a paid plan (Standard / Team / Pro, Stripe) starting with a 7-day trial, and
each plan carries `limits` (channel count) plus `capabilities` (webhooks, priority support, …). With no
`STRIPE_SECRET_KEY` the instance is in **self-hosted mode** (`selfHosted()` in lib/billing.js): every account is
entitled, `planFor()` returns a no-limits/all-capabilities "Self-hosted" plan, `/pricing` redirects to signup or the
app, and views hide pricing/trial/billing UI via `res.locals.billingEnabled`. The test suite has no Stripe key, so
it runs self-hosted by default — a test of a billing lockout sets `STRIPE_SECRET_KEY` itself (see billing.test.js). Team/Pro can
register outbound webhooks that fire on publish/failure. AI agents can also create/manage posts via an MCP
server.

## Dev environment

- Development happens on an Ubuntu VM, SMB-mounted to this Windows workspace. Treat this as one project, not two
  — there's no separate "Windows version" of the app.
- Git pushes to GitHub happen from the VM (the SSH key lives there, not on Windows). If you're working from the
  Windows side, commit locally and tell the user to `git push origin main` on the VM rather than trying to push
  yourself.
- Deployed to a VPS behind Caddy (automatic HTTPS, see `deploy/Caddyfile`), running under pm2
  (`ecosystem.config.cjs`) with **`instances: 1`** — `scheduler.js`'s node-cron jobs run in-process, so a second
  instance would double-publish due posts and double-run media cleanup. Don't change that without moving the
  scheduler out of the app process first. `scripts/deploy.sh` is the deploy sequence (pull, install, migrate,
  pm2 reload) — run it manually on the VPS; nothing deploys automatically, and no deploy CI should be added unless asked. The one
  workflow, `.github/workflows/docker-image.yml` (added at the user's request 2026-10-27), only builds and publishes
  the Docker image to ghcr.io/natewhi/postfalcon (amd64 + arm64, `latest` + `sha-<commit>`, APP_COMMIT build arg) on
  each push to main — it doesn't run tests or touch any server.
- Database backups: `lib/backup.js` runs `pg_dump` (custom format) nightly at 03:30 from scheduler.js, keeps the
  last 7 in `backups/` (git-ignored; `BACKUP_DIR` overrides) and, when `S3_BUCKET` is set, uploads each under the
  bucket's `backups/` prefix (kept 30 days; never served by `/uploads`). `npm run backup` takes one on demand. Restore:
  stop the app, `pg_restore --clean --if-exists --no-owner --single-transaction -d "$DATABASE_URL" <file>.dump`. The admin overview flags
  missing or stale backups.
- Self-hosters install with `docker compose up -d` (Dockerfile + docker-compose.yml: app + Postgres 16 + Caddy via
  `deploy/Caddyfile.docker`; the app container runs pending migrations then `index.js`, one container only) or the
  non-Docker steps in README.md, which is the public install/operator guide — keep it in step with features that change
  setup. postfalcon.co itself stays on the pm2 + scripts/deploy.sh setup below. Verified end to end on a fresh Ubuntu
  VM (devbox01) on 2026-10-26; two things that test caught must stay: Caddyfile.docker's `default_sni {$DOMAIN}`
  (browsers send no SNI to an IP address, so without it HTTPS by IP fails) and the Dockerfile's `chmod -R a+rX /app`
  after `COPY` (the app runs as `node`; files copied with private 600 modes otherwise crash it with EACCES). The
  pg_dump client in the image (postgresql16-client) must match the compose Postgres major version. The one-line
  installer, `install.sh` (served as `<BASE_URL>/install.sh`, a redirect to the raw file on GitHub), sets up
  `deploy/docker-compose.image.yml` — the same stack using the published image — with `deploy/Caddyfile.docker` and a
  generated `.env`; keep that compose file in step with the root `docker-compose.yml` (build from source).
- `.env` values (DB creds, session secret, OAuth app IDs/secrets) are entered by the user directly. Don't invent
  or insert real secrets — use placeholders in `.env.example` and let the user fill in `.env`/`.env.test`.
- Traffic/SEO analytics (referrers, top pages, trends) runs as a separate self-hosted Umami instance, not part
  of this app's own DB — Postfalcon only proxies its script/data same-origin via `/stats/*` (`routes/analytics.js`)
  when `UMAMI_HOST`/`UMAMI_WEBSITE_ID` are set. Setup/deploy steps for Umami itself: `docs/analytics-setup.md`.

## Architecture

```
app.js              Express app: helmet/CSP, sessions, CSRF, passport, route mounting, error handlers
index.js            Entry point: starts the HTTP server + the cron scheduler
scheduler.js         node-cron jobs: per-minute "publish due posts", daily 3am media cleanup, and a
                     post-metrics refresh every 3 hours. sendPost() dispatches to a per-platform
                     adapter via lib/platforms.js; refreshPostMetrics() does the same for any adapter
                     that exports fetchMetrics().
lib/platforms.js     The platform registry — the ONE place a social platform is defined (label,
                     badge/color, status live|stub|unsupported, connect style). lib/platforms/<id>.js
                     is that platform's publish adapter (only for status:'live'). Adding a platform =
                     one registry entry (+ an adapter for a live one), not edits scattered across
                     routes/scheduler/views. public/common.js's PLATFORM_META mirrors badge/color;
                     views/partials/platform-icons.ejs is the brand-mark SVG sprite (dashboard + landing).
                     YouTube/TikTok are video-only and use short-lived OAuth tokens — their adapters
                     refresh via lib/platforms/oauthRefresh.js (needs refresh_token + token_expires_at,
                     which scheduler.js's due-posts query selects). Threads uses a long-lived
                     (~60-day) access token with no separate refresh_token — it self-refreshes via a
                     bespoke helper inside lib/platforms/threads.js rather than oauthRefresh.js. TikTok's
                     Content Sharing Guidelines (checked in app review) require per-post user choices —
                     privacy level with no default, comment/duet/stitch opt-ins, commercial disclosure,
                     consent line — so the composer shows a TikTok panel fed by GET /api/tiktok/accounts/
                     :id/creator-info, and the choices travel as tiktok_options into
                     posts.platform_options.tiktok (not `metadata`: scheduler.js's join already has
                     social_accounts.metadata). With none set, the adapter posts SELF_ONLY, interactions
                     off. YouTube works the same way: a composer panel (title, visibility with no
                     default, made-for-kids) -> youtube_options -> posts.platform_options.youtube,
                     defaulting to private. YouTube's Developer Policies also drive two more optional
                     adapter exports: refreshStoredData(account), run daily by scheduler.js's
                     refreshStoredPlatformData() to refresh (or, on invalid_grant, delete) stored API
                     data beyond refreshPostMetrics()'s 30-day window, and revoke(account), called by
                     DELETE /api/v1/social-accounts/:id. The YouTube-specific legal text the audit
                     checks lives in views/privacy.ejs#youtube and views/terms.ejs. Expired/revoked
                     credentials: lib/reconnect.js classifies a publish/metrics error as an auth
                     failure (looksLikeAuthFailure — 401, invalid_grant, Meta code 190, etc.) and sets
                     social_accounts.needs_reconnect_at (+ one email); a DB trigger (migration 022)
                     clears it whenever the account gets a new access_token (reconnect or refresh), as
                     does a successful publish. The UI shows it on Accounts, the dashboard banner and
                     the sidebar dot. Bluesky
                     has no third-party OAuth at all: the user supplies a handle + an "app password"
                     (connect:'token', like Telegram's bot token), stored as access_token, and the
                     adapter just logs in fresh (short-lived session) on every publish. An adapter can
                     also export `fetchMetrics(post) -> {views, likes, comments, shares}` (any field
                     null if that platform doesn't report it) — optional, only mastodon/bluesky/
                     facebook/instagram/threads/youtube have one; telegram/tiktok/pinterest/linkedin
                     don't (no metrics API available via the scopes Postfalcon already requests).
                     Pinterest and LinkedIn both use access levels open to any registered app (not
                     the partner-approval-gated tiers each platform also has): Pinterest posts a Pin
                     to one board per account (social_accounts.metadata.board_id, same place
                     Mastodon keeps its instance domain): the first board at connect time, then
                     whatever the user picks on Accounts (GET/PATCH /api/pinterest/accounts/:id/
                     board[s]); reconnecting keeps the choice. If Pinterest refuses that board
                     (sandbox leftovers — the live API lists them with no marker — or deleted),
                     publish() tries the other boards, then creates one, saves what worked and
                     records refused ids in metadata.unusable_board_ids. Always needs an image —
                     there's no text-only Pin. LinkedIn posts to the user's
                     personal profile (not a Company Page) and is text-only for now; its access
                     token has no refresh_token for standard apps, so it just expires (~60 days)
                     and surfaces as a normal failed-post error until reconnected.
routes/              One file per resource, mounted in app.js. requireAuth applied at app.use() level,
                     not per-route (pages.js is the exception — it applies requirePageAuth per-route since
                     login/signup must stay reachable while logged out). '/' is the public landing page;
                     the authenticated calendar app lives at '/dashboard', not '/'.
middleware/          auth (session + Bearer token), validate (zod), upload (multer), rateLimit,
                     planLimit (per-plan channel caps + requireCapability(cap) gate)
routes/auth.js       Session auth: local email/password (passport-local, lib/passport.js) plus
                     "Sign in with Google" (hand-rolled OAuth, same raw-fetch pattern as every
                     platform adapter — not a passport strategy package) at GET /google +
                     /google/callback. Shares GOOGLE_CLIENT_ID/SECRET with routes/youtube.js's
                     channel-connect flow (one Google Cloud OAuth client, two redirect URIs). A
                     Google sign-in matches an existing account by google_id, then by email
                     (linking rather than duplicating), else creates one with password_hash NULL
                     and email_verified_at set immediately (Google already verified it).
                     users.password_hash is nullable for this reason — /change-password and
                     /delete-account both treat "no password_hash" as "nothing to verify, the
                     session itself is the only factor" rather than calling bcrypt on null.
lib/config.js        isConfigured()/envConfigured()/smtpConfigured(): an .env value counts as set only when non-empty
                     and not a 'change-me' placeholder. Use these, not a bare truthiness check, for any
                     "is this feature configured" decision. index.js exits at start if DATABASE_URL/
                     SESSION_SECRET/BASE_URL are empty (dotenv loaded first, app imported after the check).
lib/instanceSettings.js  instance_settings (migration 029) read per page request in app.js into res.locals:
                     siteName (header/sidebar/titles — views use <%= siteName %>, never a literal
                     "Postfalcon" in chrome), logoUrl (an uploaded logo: PNG/JPEG/WebP only, never SVG,
                     redrawn by sharp to a 256px PNG and kept with the media; replaces the "P" mark and
                     the favicon — views use <%= logoUrl || '/favicon.svg' %>) and publicSite (landing + blog; off = / redirects to /login;
                     default on only when billing is configured). Set from Admin -> Settings
                     (/api/admin/settings). Not cached, on purpose. signup_mode lives there too.
lib/                 passport strategy, mailer (real SMTP via nodemailer, falls back to console.log if
                     SMTP_* env vars are unset), token hashing, media cleanup logic,
                     storage.js (uploaded media: local public/uploads by default, or an S3-compatible
                     bucket when S3_BUCKET is set — routes/uploads.js then streams /uploads/<name>
                     from it, so media URLs never change; always go through readMedia/copyMedia/
                     deleteMedia/storeUploadedFile rather than touching uploadDir directly),
                     imageFit.js (fitForInstagram: centres a photo outside Instagram's 4:5–1.91:1 on a
                     blurred copy of itself and converts to JPEG, via `sharp` — the Instagram adapter
                     publishes that temporary copy instead of the original and deletes it afterwards),
                     billing.js (Stripe client + PLANS catalogue: per-plan limits + capabilities + trial),
                     webhooks.js (deliverWebhooks() — HMAC-signed outbound POST, fire-and-forget)
routes/billing.js    Stripe Checkout / Billing Portal / plan-status endpoints (session auth, /api/billing)
routes/billingWebhook Stripe webhook — mounted in app.js with express.raw() BEFORE express.json() and
                     csrfProtection (Stripe authenticates by signature). Updates users.plan/plan_status.
routes/metaCallbacks.js  Meta's server-to-server Threads callbacks (uninstall, data deletion) at
                     /api/meta/*: signed_request verified by HMAC with THREADS_CLIENT_SECRET, mounted
                     ahead of csrfProtection with express.urlencoded, no session auth.
routes/webhooks.js   /api/v1/webhooks CRUD for user-registered outbound webhook endpoints (Team/Pro only,
                     gated by requireCapability('webhooks'))
content/blog/*.md    The blog — one Markdown file per post (frontmatter: title, slug, description, date,
                     optional updated/draft/image/heroImage/heroGradient/redirects/tags/author — see
                     _template.md), read fresh from disk on every request (no DB table, no admin UI, no
                     caching) so editing a file — including its `slug`, i.e. its URL — takes effect
                     immediately. lib/blog.js parses them (gray-matter + marked), assigns heading ids and
                     builds each post's table of contents, and resolves `author` against the AUTHORS map
                     (placeholder initial-letter avatar until a real photo is set). `image` is card art /
                     og:image; the post page's own hero banner instead picks, richest first, `heroImage`
                     (a background-only image — no centerpiece, since one crops badly at hero height) ->
                     `heroGradient` (two hex colors) -> the same deterministic cardArt() gradient an
                     imageless post already gets on the /blog grid — see views/blog-post.ejs. routes/blog.js
                     serves /blog (paginated index) and /blog/:slug. A post's old slug(s) can be listed
                     under `redirects:` to 301 old URLs to the new one after a rename. routes/pages.js's
                     /sitemap.xml and /robots.txt are generated from the same list. This is this project's
                     own marketing content (including posts pitching self-hosting itself), not something a
                     self-hoster's instance should carry by default — `isBlogEnabled()` in lib/blog.js
                     (env var `ENABLE_BLOG`, on unless explicitly `"false"`) gates the route mount in
                     app.js, the sitemap entries, and the nav/footer `Blog` link (via `app.locals.blogEnabled`,
                     so every view has it without each route passing it explicitly) all from one place.
routes/analytics.js  Reverse-proxies /stats/* to a self-hosted Umami instance (see docs/analytics-setup.md)
                     so the tracking script/data stay same-origin — mounted with express.raw() BEFORE
                     express.json(), same reasoning as the Stripe webhook. 404s if UMAMI_HOST is unset.
                     Unrelated to routes/postAnalytics.js below — this one is Postfalcon's own traffic/SEO
                     analytics for the site owner, not user-facing post performance.
routes/postAnalytics.js  /api/v1/analytics/summary — aggregates the metric_* columns scheduler.js keeps
                     refreshed into per-day series for ?days=7|30|90 (bucketed in ?tz=, the viewer's IANA timezone), period totals, a per-platform breakdown, the period's posts, and all-time totals + a top post (null = no post in scope reports that metric). Backs views/analytics.ejs
                     (the "Analytics" sidebar page) and is also just another /api/v1 endpoint, so
                     GET /api/v1/posts carries the same raw metric_* fields on every post for scripts/
                     agents (lib/mcpServer.js's get_analytics_summary tool wraps this endpoint).
db/                  pool.js (pg Pool), migrate.js (runner), migrations/NNN_name.sql (hand-written SQL)
views/*.ejs          One view per page; each has its own full <head> (no shared layout — see below)
views/partials/      sidebar, verify-banner, site-header, analytics (public/auth pages) — included via
                     <%- include(...) %>
public/*.js          One script per page, matching the view name (dashboard.ejs -> dashboard.js)
public/csrf.js       Loaded on every page (before common.js / before the page script on pages without it).
                     Exposes getCsrfToken(), lazily fetched from GET /api/csrf-token and cached in memory.
public/common.js     Shared helpers, loaded before the page script on pages that have a sidebar
public/style.css     Single stylesheet, CSS custom properties for theming, BEM-ish flat class names
lib/mcpServer.js     createMcpServer({baseUrl, token}) — the one place all 6 MCP tools
                     (list_accounts/list_posts/create_post/update_post/delete_post/
                     get_analytics_summary) are defined, each a thin call against Postfalcon's own
                     REST API. Shared by both ways to reach them:
mcp/server.js        ...over stdio, for clients that spawn a local process (Claude Desktop,
                     Cursor's `command` config) — reads POSTFALCON_BASE_URL/POSTFALCON_API_TOKEN from
                     the environment.
routes/mcp.js        ...over Streamable HTTP at POST /mcp, for clients that connect via a URL
                     instead (ChatGPT, Claude.ai, Cursor's `url` config, or any other Streamable
                     HTTP client) — a fresh McpServer + transport per request (stateless mode,
                     no session id), authenticated by the caller's own `Authorization: Bearer
                     pf_...` header (the same api_tokens a user generates for the REST API — no
                     separate MCP-specific token). Own CORS (origin '*', like /api/v1); not
                     mounted under /api since it isn't versioned REST and doesn't need
                     csrfProtection (Bearer-only, same reasoning as everything else under
                     /api/v1).
tests/               vitest + supertest, one file per resource, run against a real Postgres test DB
```

## Conventions to keep consistent

These aren't enforced by a linter — follow them by hand so the codebase doesn't fragment as it grows.

**Backend / routes**
- Every route file: `Router()` at the top, zod schemas defined near the top of the file, handlers wrapped in
  `asyncHandler()` from `utils/asyncHandler.js`, validation via `validate(schema)` middleware from
  `middleware/validate.js`. Don't hand-roll try/catch or manual body validation in a route handler.
- All DB access is raw SQL via `pool.query()` (the `pg` package) — no ORM. Keep it that way; don't introduce one.
- Schema changes go in a new numbered file under `db/migrations/` (`008_whatever.sql`, sequential, never edit an
  already-applied migration). `schema_migrations` tracks what's been applied; `npm run migrate` runs pending ones.
- Scope every query to `req.user.id` (or join through it) — there's no other tenant isolation. Copy the pattern in
  `routes/posts.js`/`routes/socialAccounts.js` for "list mine", "get mine by id" (404, not 403, for someone else's
  row), etc.
- `requireAuth` (middleware/auth.js) accepts either a Passport session or a Bearer `api_tokens` token, so every
  `/api/*` route works for both the browser and MCP/agent callers. Don't add a second auth mechanism — extend this
  one if new callers need something.
- The externally-consumable resource API (currently `posts`, `social-accounts`) is versioned under `/api/v1/*` and
  documented publicly at `/api-docs` (`views/api-docs.ejs`, route in `routes/pages.js`, no login required). It's
  also the only part of `/api` with CORS enabled (`app.js`, scoped to `/api/v1`, no credentials — safe to open
  since Bearer auth can't be forged cross-origin the way a cookie session can) and rate-limited per user via
  `apiLimiter` in `middleware/rateLimit.js` (keyed by `req.user.id`, not IP, since it runs after `requireAuth`).
  `auth`/`users`/`mastodon`/`facebook`/`telegram`/`billing`/`csrf-token` stay unversioned — they're
  session/cookie-based web-app plumbing (login, OAuth redirects, platform connect flows, checkout, CSRF
  issuance), not part of the external contract. If you add a new externally-useful resource route, mount it
  under `/api/v1`, add `apiLimiter`, and add it to `/api-docs`.
- Billing: plans live in `lib/billing.js` (`PLANS` — each has `priceUsd`, `priceUsdYearly`, `limits`, `capabilities`,
  `features`). Every plan has a monthly and a yearly Stripe Price (yearly = "2 months free"), created and kept in step
  with `priceUsd`/`priceUsdYearly` by `npm run stripe:setup` (`scripts/stripe-setup.js`: products, prices, portal plan
  switching, webhook endpoint; idempotent, test or live). The app charges by lookup key `postfalcon_<plan>_<interval>`
  and maps a subscription back to its plan by the Price's `metadata.plan`, so .env holds no Price ids (the old
  `STRIPE_PRICE_*` vars are only a fallback). To change a price: edit `lib/billing.js`, deploy, run the script; checkout takes `interval`, and the plan cards (`views/partials/pricing-cards.ejs`, shared by
  landing + pricing, toggled by `public/billing-toggle.js`) pass yearly through signup as `?plan=<plan>-yearly`.
  Billing invariants: the trial is decided by the customer's real Stripe subscription history (`trialEligible`), not by
  having a `stripe_customer_id` (one exists after an abandoned Checkout); Checkout refuses a second running
  subscription (409, plan changes go through the portal); the webhook applies the customer's *current* subscription
  fetched from Stripe (`currentSubscription`), never the event's copy, since events arrive out of order; account
  deletion cancels running subscriptions first; and scheduler.js fails (rather than publishes) due posts of a
  non-entitled user. `plan_cancels_at` (migration 024) is set while a cancelled subscription runs to period end.
  Admin pages (`requireAdmin`, linked from the sidebar's admin-only section): `/admin/overview` (setup warnings —
  test-mode/sandbox settings left on, missing config — scheduler heartbeat via `lib/schedulerHeartbeat.js` plus
  overdue posts, publishing failures and reconnects, business numbers incl. an MRR estimate from
  `users.plan_interval` (migration 025), storage use; all from `lib/adminStatus.js`, never returning secret values),
  `/admin/customers` (lookup + give/remove free access for logins without a Stripe subscription, and make/remove
  admins — an admin can't remove their own rights, so one always remains; the very first account on a fresh install
  is made admin on `pro`/`active` by a trigger, migration 028, which tests/setup.js disables for the suite; plus
  the Sign-ups section: open / invite-only / closed and one-time 14-day invite links, `lib/signups.js` +
  migration 029 — both account-creating paths, POST /api/users and a first Google sign-in, go through
  `signupGate()` + `createUserThroughGate()`, and the first account on an empty instance is always allowed; and per
  customer: password-reset link to hand over, resend/mark email verification, suspend (`users.suspended_at`,
  migration 030 — enforced in lib/passport.js login + deserializeUser, Bearer auth, Google sign-in and scheduler.js),
  delete (lib/accounts.js `deleteUserAccount()`, shared with the user's own delete-account), revoke API token. Admins
  can't suspend/delete themselves or another admin. Overview also has Backups (list, back up now, download, restore
  steps) and Email (`sendTestMail()` in lib/mailer.js — add new mailer exports to tests/setup.js's mock too),
  plus Alerts: lib/alerts.js `checkAlerts()` (every 10 min from scheduler.js, or "Check now") compares
  `currentProblems()` — overdue/stuck posts, scheduler error, per-platform failure bursts, stale backups, server-error
  spikes — with `admin_alerts` (migration 031) and emails all admins once on start, daily while active, once on
  resolve (instance setting `alert_emails`). Activity -> Server errors reads `server_errors`, filled by a pino
  `logMethod` hook in lib/logger.js for every error/fatal line (lib/errorLog.js; rate-capped, pruned at 30 days,
  inert under test since the test logger is silent), Version (lib/version.js: running commit read from .git files
  — .dockerignore lets HEAD/refs through — vs GitHub main via the API, cached 6h, `UPDATE_CHECK=false` to disable;
  plus `pendingMigrations()`, also a red setup check), and Failed posts across all customers with bulk retry
  (status back to 'scheduled', same as a user's own retry; last 7 days only),
  `/admin/platforms` (switch each built platform on/off — `platform_settings`, migration 027, loaded into
  lib/platforms.js by `lib/platformSettings.js`; a platform with no saved switch uses the registry default,
  i.e. on unless `unlisted`), and `/admin/activity` (logs + Billing). Off means: dropped from
  `connectablePlatforms()`/`livePlatforms()` (Accounts page, landing — whose platform lists are generated, not
  hardcoded), connect routes 404 via `platformGate()` in app.js, and `isPlatformPaused()` fails its due posts
  in scheduler.js and skips its metrics. "Offered to users" is `isPlatformOffered()` = switched on AND its
  `PLATFORM_CREDENTIAL_ENV` key set (so a fresh install hides platforms it has no developer app for); use it, not
  `unlisted` or a bare `isPlatformEnabled()`, for anything user-facing. `PLATFORM_SETUP` (lib/platforms.js) holds
  each platform's developer-console URL, callback paths, .env keys and caveats for Admin -> Platforms'
  "How to set up" — add an entry for a new platform. Tests
  that need an unlisted platform's connect routes switch it on with `savePlatformSetting()` and clear it after.
  `lib/billingSync.js` holds `applySubscription`/`applyCurrent` (used by the webhook) and `reconcileSubscriptions`,
  run nightly by scheduler.js and on demand from the admin page's Billing section — it only touches customers who
  have a Stripe subscription and skips admins, so hand-set review/test logins survive it. `STRIPE_REQUIRE_TERMS=true`
  adds a required Terms tick to Checkout (live only: Stripe needs a Terms URL in business details first);
  `users.plan`/`plan_status`/`plan_renews_at` are the app's read-fast copy of Stripe state, written only by
  `routes/billingWebhook.js`. New rows default to `plan='standard'`, `plan_status='incomplete'` (migration 023 — not
  entitled until Stripe Checkout completes and the webhook sets `trialing`/`active`), and Checkout adds a 7-day
  `trial_period_days` for never-subscribed customers. The only free use is the open platforms: `FREE_PLATFORMS`
  (mastodon/bluesky/telegram) in lib/billing.js work for any account, entitled or not, capped at Standard's channel
  count over those platforms — `canUsePlatform()` in scheduler.js, and in middleware/planLimit.js
  (`atAccountLimit(user, platform)` — pass the platform from a free platform's connect route —,
  `enforceAccountLimit`, and `enforceScheduledPostLimit`, which looks up the post's target accounts). Not a Stripe
  plan and no capabilities beyond Standard's; webhooks stay paid. Signup with no plan picked lands on /dashboard. A test/
  reviewer login that should work without Stripe is just set to `plan_status='active'` by hand. `isEntitled(user)` (plan_status in active/trialing/past_due) is the "can still publish" gate;
  when a subscription lapses the `plan` string sticks and `plan_status` drives the lockout. Enforce with the
  middleware in `middleware/planLimit.js`: `enforceAccountLimit` (402 `plan_limit`), `enforceScheduledPostLimit`
  (still entitlement-checks even though every paid queue is unlimited), and `requireCapability('webhooks'|…)`
  (402 `plan_capability`) — added to the route chain after `validate()`. In a handler, gate features with
  `planHasCapability(req.user.plan, cap)`; never read Stripe directly in a request. The Stripe SDK is lazy
  (`getStripe()` in `lib/billing.js`); tests mock the `stripe` module and set `STRIPE_PRICE_*` env in a `beforeAll`.
- Cross-posting: `POST /api/v1/posts` takes `social_account_ids` (JSON array / repeated field / single) as well
  as `social_account_id`. It writes one `posts` row per channel sharing a `crosspost_group_id`; the first keeps
  the uploaded files, the rest get copied media (so per-post media cleanup can't orphan another's file). N>1
  responds `{ crosspost_group_id, posts: [...] }`; N==1 responds the bare post (unchanged). Gated by the
  `crossPosting` capability.
- Repeated posts: `posts.repeat_interval` (daily/weekly/monthly) + optional `repeat_until` + `repeat_parent_id`.
  After a recurring post publishes, `scheduler.js` `scheduleNextOccurrence()` clones the next occurrence (with
  copied media, 1-year hard cap). Gated by the `repeatedPosts` capability.
- Outbound webhooks: `lib/webhooks.js` `deliverWebhooks(userId, event, data)` — fired (not awaited) from
  `scheduler.js` on `post.published` / `post.failed`. Each POST carries `X-Postfalcon-Event` and
  `X-Postfalcon-Signature: sha256=<hmac-sha256 of the raw body with the endpoint secret>`, 8s timeout, no retry.
  The signing secret is returned only once, at creation.
- Every mutating `/api/*` route is behind CSRF protection (`app.js`, via `csrf-csrf`'s double-submit cookie
  pattern) — GET/HEAD are exempt automatically, and requests carrying an `Authorization: Bearer` header are
  exempt too (Bearer auth isn't cookie-based, so it isn't CSRF-able; this matters for MCP/agent callers, who
  never send a CSRF token). Skipped entirely when `NODE_ENV=test` (same pattern `authLimiter` already uses) so
  the existing supertest suite doesn't need to fetch a token per mutating request — there's no dedicated test
  proving the protection itself works, only that it's correctly bypassed in tests.
- Real emails go through `lib/mailer.js`'s `sendMail()`, backed by `nodemailer` over SMTP. If `SMTP_HOST`/
  `SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` aren't all set in `.env`, it silently falls back to logging the email
  instead of sending — this is normal for local dev, not a bug. Tests always hit the mocked version
  (`tests/setup.js`), never real SMTP.
- Server runtime code (`app.js`, `scheduler.js`, `index.js`, `lib/*`) logs through `lib/logger.js`'s pino
  instance (structured JSON to stdout, level via `LOG_LEVEL`) instead of `console.*` — `app.js` also wires
  `pino-http` so every request gets a per-request `req.log`. Standalone CLI scripts (`db/migrate.js`,
  `mcp/server.js`, `scripts/copy-vendor.js`) keep using `console.*`, since stdout is their actual output
  contract, not a log stream.

**Frontend**
- No inline `<script>` or `<style>` — the CSP is `script-src 'self'` with no `'unsafe-inline'`. Anything that
  needs to run must be an external file under `public/`. Same reasoning is why FullCalendar is self-hosted (see
  `scripts/copy-vendor.js` / `postinstall`) instead of pulled from a CDN — don't add CDN `<script src>` tags.
- Every page's `<head>` repeats the same boilerplate (charset, `theme-init.js`, color-scheme meta, title, favicon,
  stylesheet). There's no shared layout partial for `<head>` — if you add a new page, copy the existing head block
  from another view rather than improvising a different structure. Every local `/*.js`/`/*.css` link carries
  `?v=<%= assetVersion %>` (`app.locals.assetVersion`, new on each process start) — static files are cached 7
  days in production, so a link without it keeps serving returning visitors the pre-deploy file.
- The public + auth pages (landing, pricing, api-docs, login, signup, forgot/reset-password, 404) share one
  header via `<%- include('partials/site-header') %>` — an always-dark bar (its own `--site-header-*` tokens,
  same call as the always-dark sidebar) with the "P" mark, "Postfalcon", and Pricing / API / Log in / Start free
  trial links. It reads an optional `loggedIn` local (guarded with `typeof`) to swap the auth links for "Open
  app". The in-app pages use `partials/sidebar.ejs` instead — don't put the site-header there. `favicon.svg` is
  the same "P" mark.
- Those same pages also carry `class="dark-canvas"` (on the `.landing` wrapper, or `<body>` for the auth
  pages) — a committed-dark background with a fixed 64px calendar-grid `::before` (masked radial fade), the
  landing-page look. `.dark-canvas` also holds the dark overrides for `.api-docs` code/tables and floats the
  `.auth-card` as a light panel on the grid; `.pricing-page` adds only the pricing-card-specific dark styling
  and the headline glow. `/dashboard` and the rest of the app keep the theme-aware light/dark chrome.
- Trial/onboarding flow: every "Start free trial" CTA points to `/pricing`. A logged-out visitor picking a plan
  goes to `/signup?plan=<id>`; `signup.js` creates the account, auto-logs-in, and redirects to
  `/pricing?start=<id>`, where `pricing.js` immediately calls `POST /api/billing/checkout` and hands off to the
  Stripe Checkout page (card always collected — `payment_method_collection: 'always'`). Plain `login.js` just
  goes to `/dashboard` — plan selection is a signup-time step, not a gate on every login. `/pricing` only marks
  a plan as "current" (disabling its button) once the user has a Stripe customer, so a brand-new account on the
  `standard` default can still start any plan.
- Never use native `alert()`/`confirm()`. Use `showToast(message, type, link)` for messages and
  `confirmDialog(message, { confirmText, cancelText })` for anything that needs a yes/no — both are in
  `public/common.js`. This was an explicit product requirement; don't regress it.
- `apiJson(path, options)` (also in `common.js`) is the standard fetch wrapper — it redirects to `/login` on 401,
  returns `null` (not a parse error) on 204, and auto-attaches the `x-csrf-token` header (via `getCsrfToken()`
  from `csrf.js`) for any non-GET request. Use it instead of raw `fetch()` for API calls. On the standalone auth
  pages that don't load `common.js` (login/signup/forgot-password/reset-password), `csrf.js` is still loaded, so
  their raw `fetch()` POSTs manually add `'x-csrf-token': await getCsrfToken()` to the headers — if you add
  another mutating fetch call anywhere, on any page, it needs that header or the request will 403.
- Theming: colors live as CSS custom properties on `:root` (light values) with dark overrides under
  `[data-theme="dark"]` in `public/style.css` — **not** `@media (prefers-color-scheme: dark)`. The actual light/
  dark decision is made once by `public/theme-init.js` (reads `localStorage['postfalcon-theme']`, falls back to
  `prefers-color-scheme`, stamps `data-theme` on `<html>` before paint) and toggled via the sidebar button wired
  in `common.js`. If you add new themed colors, add both the light default and the `[data-theme="dark"]`
  override — don't hardcode a hex value that only looks right in one theme.
- The sidebar itself is intentionally always-dark regardless of theme (`--color-sidebar-bg`/`--color-sidebar-text`
  are separate variables from the page background) — this was a deliberate choice, not an oversight. Anything
  placed in the sidebar (buttons, links) needs to stay legible against a dark background in *both* themes, so
  style it off the sidebar variables, not `--color-primary` (which does change with theme and can end up matching
  the sidebar background — this already caused one bug with the logout button).

**Testing**
- Tests hit a real Postgres test database (`postfalcon_test` via `.env.test`) — no DB mocking. External HTTP (OAuth,
  posting APIs) is mocked with `vi.stubGlobal('fetch', ...)`; the mailer is mocked globally in `tests/setup.js`.
- The `posts` table has a `BEFORE UPDATE` trigger that forces `updated_at = now()`. You cannot backdate
  `updated_at`/`posted_at` via `UPDATE` in a test fixture — insert the row directly with the backdated timestamp
  instead (triggers don't fire on INSERT). See `tests/mediaCleanup.test.js` for the pattern.
- `tests/setup.js` resets the test DB's `users.plan_status` default to `'trialing'`, so users signed up via
  `POST /api/users` in tests act as if they'd finished Checkout. To test the real never-checked-out state, set
  `plan_status = 'incomplete'` on the user explicitly (see `tests/billing.test.js`).
- One test file per resource, matching the route file name. Add new tests there rather than starting a new file.
- tests/setup.js makes the suite a fully set-up self-hosted server: placeholder keys for every platform (set with
  `||=`), no Stripe key, `public_site` switched on before each test, and the first-user-admin trigger disabled.
  A test of the opposite case changes that itself and puts it back.

## Before adding a feature, check

- **New API route?** New/extended zod schema, `validate()` + `asyncHandler()`, scoped to `req.user.id`, mounted
  in `app.js` behind `requireAuth`, and a test in the matching `tests/*.test.js` file. If it's meant for external
  scripts/agents (not just the Postfalcon frontend), mount it under `/api/v1`, add `apiLimiter`, and document it in
  `views/api-docs.ejs`.
- **New page?** New `views/<name>.ejs` with the standard head boilerplate, matching `public/<name>.js`, add the
  route in `routes/pages.js` behind `requirePageAuth`, add a sidebar nav link if it belongs in the main app shell.
  A public/marketing/auth page instead includes `partials/site-header` (and skips `requirePageAuth`).
  Load `<script src="/csrf.js">` before the page script (and before `common.js`, if used) if the page will ever
  POST/PATCH/DELETE.
- **New social platform?** Add/adjust its entry in `lib/platforms.js` (`status`, `connect`, badge/color). For a
  `live` one: write `lib/platforms/<id>.js` exporting `publish(post) -> platformPostId`, add the connect flow
  (OAuth router, or a `/api/<platform>/connect` token route like `routes/telegram.js`), mirror badge/color into
  `public/common.js`'s `PLATFORM_META`, and add a bespoke connect block in `views/accounts.ejs` if `connect`
  isn't `manual`. Tests: `tests/<platform>.test.js` for the connect route + a posting case in
  `tests/scheduler.test.js`. Widen the `social_accounts.platform` CHECK in a new migration if the id is new.
  If the platform's API exposes engagement counts, also export `fetchMetrics(post) -> {views, likes,
  comments, shares}` (null for whatever it doesn't report) — scheduler.js picks it up automatically, no
  other change needed for it to show up in Analytics.
- **New blog post?** Copy `content/blog/_template.md` (a draft — safe to leave in place, it's never listed),
  fill in `title`/`slug`/`description`/`date`, remove `draft: true` when ready. Optional frontmatter: `tags`
  (pills on the post + index card), `author` (id into the `AUTHORS` map in `lib/blog.js` — add a person there
  before referencing them), `image`, `heroImage`/`heroGradient` (the post page's own hero banner —
  see content/blog/*.md above), `redirects` (old slugs that 301 here after a rename). `##`/`###`
  headings automatically get anchor ids and populate the "Contents" sidebar — no manual markup needed. No
  route/view/DB change needed for a new post either way.
- **New author avatar?** Just drop an image at `public/images/authors/<author-id>.jpg` (or `.png`/`.webp`) —
  matched by the same id used in `AUTHORS`/frontmatter `author:`, re-checked on every request (no caching, no
  code change). Falls back to a plain initial-letter badge when no file matches. See
  `public/images/authors/README.md`.
- **New user-facing message?** `showToast`/`confirmDialog`, never a native dialog.
- **New color?** A CSS custom property with both a light default and a `[data-theme="dark"]` override.
- **New external script?** Self-host it under `public/` (or `public/vendor/` via `copy-vendor.js`) — the CSP
  won't allow a CDN `<script src>` or inline script.

## Suggestion

This file is the right mechanism for keeping conventions consistent — Claude Code loads it automatically every
session, so it doesn't rely on you re-explaining the same rules. If it grows too large as the app expands (e.g.
once there's a real deployment/ops section, or platform-specific posting quirks worth documenting in depth), split
those out into files under a `docs/` folder and pull them in with `@docs/whatever.md` import syntax rather than
letting this file balloon — but for the project's current size, one file is the right amount of ceremony.
