# Postfox

Social media post scheduler. Node.js/Express backend, Postgres, EJS server-rendered views, vanilla JS on the
frontend (no framework, no bundler). Users connect social accounts (Mastodon, Facebook, Instagram, and stubs for
Twitter/LinkedIn/TikTok/Threads), compose posts as drafts or schedule them, and a per-minute cron job publishes
due posts. AI agents can also create/manage posts via an MCP server.

## Dev environment

- Development happens on an Ubuntu VM, SMB-mounted to this Windows workspace. Treat this as one project, not two
  — there's no separate "Windows version" of the app.
- Git pushes to GitHub happen from the VM (the SSH key lives there, not on Windows). If you're working from the
  Windows side, commit locally and tell the user to `git push origin main` on the VM rather than trying to push
  yourself.
- No production deployment yet. A VPS can pull from GitHub, but deploying is explicitly deferred until there's
  enough built to be worth pushing to prod. Don't set up CI/CD or deployment tooling unless asked.
- `.env` values (DB creds, session secret, OAuth app IDs/secrets) are entered by the user directly. Don't invent
  or insert real secrets — use placeholders in `.env.example` and let the user fill in `.env`/`.env.test`.

## Architecture

```
app.js              Express app: helmet/CSP, sessions, CSRF, passport, route mounting, error handlers
index.js            Entry point: starts the HTTP server + the cron scheduler
scheduler.js         node-cron jobs: per-minute "publish due posts", daily 3am media cleanup
routes/              One file per resource, mounted in app.js. requireAuth applied at app.use() level,
                     not per-route (pages.js is the exception — it applies requirePageAuth per-route since
                     login/signup must stay reachable while logged out). '/' is the public landing page;
                     the authenticated calendar app lives at '/dashboard', not '/'.
middleware/          auth (session + Bearer token), validate (zod), upload (multer), rateLimit
lib/                 passport strategy, mailer (real SMTP via nodemailer, falls back to console.log if
                     SMTP_* env vars are unset), token hashing, media cleanup logic
db/                  pool.js (pg Pool), migrate.js (runner), migrations/NNN_name.sql (hand-written SQL)
views/*.ejs          One view per page; each has its own full <head> (no shared layout — see below)
views/partials/      sidebar, verify-banner — included via <%- include(...) %>
public/*.js          One script per page, matching the view name (dashboard.ejs -> dashboard.js)
public/csrf.js       Loaded on every page (before common.js / before the page script on pages without it).
                     Exposes getCsrfToken(), lazily fetched from GET /api/csrf-token and cached in memory.
public/common.js     Shared helpers, loaded before the page script on pages that have a sidebar
public/style.css     Single stylesheet, CSS custom properties for theming, BEM-ish flat class names
mcp/server.js        MCP stdio server exposing list_accounts/list_posts/create_post/update_post/delete_post,
                     authenticates against the running app via a Bearer api_token (POSTFOX_BASE_URL/POSTFOX_API_TOKEN)
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
- Every mutating `/api/*` route is behind CSRF protection (`app.js`, via `csrf-csrf`'s double-submit cookie
  pattern) — GET/HEAD are exempt automatically, and requests carrying an `Authorization: Bearer` header are
  exempt too (Bearer auth isn't cookie-based, so it isn't CSRF-able; this matters for MCP/agent callers, who
  never send a CSRF token). Skipped entirely when `NODE_ENV=test` (same pattern `authLimiter` already uses) so
  the existing supertest suite doesn't need to fetch a token per mutating request — there's no dedicated test
  proving the protection itself works, only that it's correctly bypassed in tests.
- Real emails go through `lib/mailer.js`'s `sendMail()`, backed by `nodemailer` over SMTP. If `SMTP_HOST`/
  `SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` aren't all set in `.env`, it silently falls back to `console.log` instead
  of sending — this is normal for local dev, not a bug. Tests always hit the mocked version
  (`tests/setup.js`), never real SMTP.

**Frontend**
- No inline `<script>` or `<style>` — the CSP is `script-src 'self'` with no `'unsafe-inline'`. Anything that
  needs to run must be an external file under `public/`. Same reasoning is why FullCalendar is self-hosted (see
  `scripts/copy-vendor.js` / `postinstall`) instead of pulled from a CDN — don't add CDN `<script src>` tags.
- Every page's `<head>` repeats the same boilerplate (charset, `theme-init.js`, color-scheme meta, title, favicon,
  stylesheet). There's no shared layout partial for `<head>` — if you add a new page, copy the existing head block
  from another view rather than improvising a different structure.
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
  dark decision is made once by `public/theme-init.js` (reads `localStorage['postfox-theme']`, falls back to
  `prefers-color-scheme`, stamps `data-theme` on `<html>` before paint) and toggled via the sidebar button wired
  in `common.js`. If you add new themed colors, add both the light default and the `[data-theme="dark"]`
  override — don't hardcode a hex value that only looks right in one theme.
- The sidebar itself is intentionally always-dark regardless of theme (`--color-sidebar-bg`/`--color-sidebar-text`
  are separate variables from the page background) — this was a deliberate choice, not an oversight. Anything
  placed in the sidebar (buttons, links) needs to stay legible against a dark background in *both* themes, so
  style it off the sidebar variables, not `--color-primary` (which does change with theme and can end up matching
  the sidebar background — this already caused one bug with the logout button).

**Testing**
- Tests hit a real Postgres test database (`postfox_test` via `.env.test`) — no DB mocking. External HTTP (OAuth,
  posting APIs) is mocked with `vi.stubGlobal('fetch', ...)`; the mailer is mocked globally in `tests/setup.js`.
- The `posts` table has a `BEFORE UPDATE` trigger that forces `updated_at = now()`. You cannot backdate
  `updated_at`/`posted_at` via `UPDATE` in a test fixture — insert the row directly with the backdated timestamp
  instead (triggers don't fire on INSERT). See `tests/mediaCleanup.test.js` for the pattern.
- One test file per resource, matching the route file name. Add new tests there rather than starting a new file.

## Before adding a feature, check

- **New API route?** New/extended zod schema, `validate()` + `asyncHandler()`, scoped to `req.user.id`, mounted
  in `app.js` behind `requireAuth`, and a test in the matching `tests/*.test.js` file.
- **New page?** New `views/<name>.ejs` with the standard head boilerplate, matching `public/<name>.js`, add the
  route in `routes/pages.js` behind `requirePageAuth`, add a sidebar nav link if it belongs in the main app shell.
  Load `<script src="/csrf.js">` before the page script (and before `common.js`, if used) if the page will ever
  POST/PATCH/DELETE.
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
