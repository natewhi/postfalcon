# Postfalcon

Open-source social media scheduler. Write a post once, schedule it on a calendar, and
Postfalcon publishes it on time to **Mastodon, Bluesky, Facebook, Instagram, Threads,
Telegram, YouTube, TikTok, Pinterest and LinkedIn** (X is built in too, for anyone on a paid
X API plan).

- **Calendar** with drag-to-reschedule, drafts and a failed-posts view
- **Cross-posting**: one composer, many channels, with per-platform options (TikTok privacy,
  YouTube title and visibility, Pinterest board)
- **Recurring posts**: daily, weekly or monthly
- **Analytics**: views, likes, comments and shares pulled back from the platforms that report them
- **REST API** and an **MCP server**, so scripts and AI agents (Claude, ChatGPT, Cursor, …)
  can plan and publish posts
- **Outbound webhooks** when a post publishes or fails
- **Admin pages** for everything an operator needs: who can sign up, invite links, admin
  rights, which platforms are offered, setup checks, backups and logs. No SQL needed.

Use the hosted version at [postfalcon.co](https://postfalcon.co), or run it yourself: this
repository is the whole thing.

---

## Install with Docker (recommended)

You need a Linux server (x86 or ARM) and a domain or subdomain whose DNS points at it, with
ports 80 and 443 open. Caddy, included, gets the HTTPS certificate on its own. It uses about
100 MB of memory at rest, so a 1 GB server is enough.

### One-line install

```bash
curl -fsSL https://postfalcon.co/install.sh | sh
```

It checks for Docker (and offers to install it), asks for your domain, generates the passwords,
and starts Postfalcon in `~/postfalcon` from the published image. It changes nothing else on the
machine and never overwrites an existing install. To read it before running it:

```bash
curl -fsSL https://postfalcon.co/install.sh -o install.sh
less install.sh
sh install.sh
```

When it finishes, open the address it prints and choose **Sign up**. **The first account becomes
the admin**, so do this straight away, before anyone else can reach the server.

To update an install made this way:

```bash
cd ~/postfalcon
docker compose pull
docker compose up -d
```

### Install by hand, from source

The same thing step by step, building the image on the server instead of downloading it (2 GB of
memory is comfortable while it builds). Install Docker if the server doesn't have it, and let
your user run it:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # then log out and back in
```

Then get Postfalcon:

```bash
git clone https://github.com/natewhi/postfalcon.git
cd postfalcon
cp .env.example .env
```

Edit `.env` (e.g. `nano .env`) and fill in the **REQUIRED** section:

| Setting             | What to put                                                    |
| ------------------- | -------------------------------------------------------------- |
| `BASE_URL`          | `https://` + your domain, e.g. `https://social.example.com`    |
| `DOMAIN`            | the domain on its own, e.g. `social.example.com`               |
| `SESSION_SECRET`    | a random string: run `openssl rand -hex 32` and paste it       |
| `POSTGRES_PASSWORD` | another random string, for the bundled database                |

Then start it (the first start builds the image, which takes a few minutes):

```bash
docker compose up -d
docker compose ps        # db, app and caddy running; app shows "healthy" after ~30 seconds
```

Open your `BASE_URL`: you'll see the log in page. Choose **Sign up**. **The first account
becomes the admin**, so do this straight away, before anyone else can reach the server.

**Trying it out without a domain**, on your own computer or a machine on your network: use
`localhost` or the machine's IP address (with the installer, enter it as the domain; by hand, use
it for both, e.g. `DOMAIN=192.168.1.20` and `BASE_URL=https://192.168.1.20`). Your browser will warn about the certificate; that's expected,
choose to continue. Most social platforms only accept a real public `https://` domain for their
login callbacks, so on a test setup like this only Mastodon, Bluesky and Telegram can be
connected.

To update an install from source:

```bash
git pull
docker compose up -d --build
```

### Updates, data and backups (either way)

Database changes are applied automatically when the app starts. Admin → Overview → **Version**
shows how many commits behind GitHub your server is, and whether every database change is applied.

Your data (database, uploaded media, backups, certificates) lives in Docker volumes, not in the
`postfalcon` folder, so updating, rebuilding or `docker compose down` never touches it.
`docker compose down -v` **does** delete the volumes; don't use it unless you mean to start over.

Run the commands below from the install folder (`~/postfalcon` for the installer, or your clone).

- Logs: `docker compose logs -f app`. Every request is logged; set `LOG_LEVEL=warn` in `.env`
  to see only problems. Errors are also listed in Admin → Activity → Server errors.
- Backups run every night at 03:30 (server time) into the `backups` volume; the last 7 are
  kept. Set the `S3_*` settings to copy each one to a bucket as well. Admin → Overview tells
  you if they stop, and lists them with **Back up now**, **Download** and **Delete**.
- Keep a copy somewhere other than the server: download one now and then, or set up a bucket.
- Restore one (or follow "How to restore a backup" on Overview):

  ```bash
  docker compose exec app ls backups                        # pick a file
  docker compose cp app:/app/backups/<file>.dump ./restore.dump
  docker compose stop app
  docker compose exec -T db pg_restore --clean --if-exists --no-owner \
    -U postfalcon -d postfalcon < restore.dump
  docker compose start app
  ```

### Troubleshooting

| What you see | What to do |
| --- | --- |
| `permission denied while trying to connect to the docker API` | Your user isn't in the `docker` group yet: `sudo usermod -aG docker $USER`, then log out and back in. |
| The browser shows **502 Bad Gateway** | Caddy is up but the app isn't. `docker compose logs app --tail 50` says why; a missing `.env` setting is named there. |
| The app stops with `Missing required settings in .env` | Fill in that setting (see the table above), then `docker compose up -d`. |
| The installer says it's already installed | It found `~/postfalcon/.env` and changed nothing. Update with `docker compose pull && docker compose up -d` there, or move that folder away to start fresh. |
| A certificate error for a real domain | Its DNS must point at this server and ports 80 and 443 must be reachable from the internet; `docker compose logs caddy` shows what Let's Encrypt said. |
| Changes to `.env` don't take effect | Run `docker compose up -d` again; it recreates the app with the new settings. |

---

## Install without Docker

You need Node.js 20 or newer, PostgreSQL 14 or newer (with `pg_dump` on the path, for
backups), and a reverse proxy for HTTPS ([`deploy/Caddyfile`](deploy/Caddyfile) is a
two-line Caddy config).

```bash
git clone https://github.com/natewhi/postfalcon.git
cd postfalcon
cp .env.example .env          # fill in the REQUIRED section, including DATABASE_URL
npm ci --omit=dev
npm run migrate
npm start                     # or: pm2 start ecosystem.config.cjs --env production
```

Run **exactly one** copy of the app. The scheduler that publishes posts runs inside it, and a
second copy would publish everything twice. [`scripts/deploy.sh`](scripts/deploy.sh) is the
update sequence (pull, install, migrate, reload) for a pm2 setup.

---

## After installing

Everything below is done from the app, in the **Admin** section of the sidebar.

1. **Admin → Overview** lists anything not set up yet: email, backups, platforms, security.
   Work through it until it's green.
2. **Admin → Customers → Sign-ups**: choose who can create an account. The options are anyone,
   invite link only, or closed. On a server with a public address, pick invite-only and send
   people invite links.
3. **Admin → Platforms**: switch platforms on or off. Open **How to set up** under each one to
   see where to create its developer app, the callback URL to register, and which `.env` keys
   it needs. A platform only appears to users once its keys are set.
4. **Admin → Settings**: the site's name and logo, and whether `/` shows the public landing
   page or goes straight to log in. Log in is the default for a self-hosted server.
5. **Email** (optional, recommended): fill in `SMTP_*` in `.env` so verification and
   password-reset emails are actually sent. Any SMTP provider works.
   Then use **Send test email** on Overview to check it works.
6. **Alerts**: with email working, every admin is emailed when something needs attention, such
   as posts not going out, backups stopping, a burst of failures on one platform, or a run of server
   errors. Admin → Settings can turn this off. These checks run inside the app, so add an outside
   uptime monitor (any free one that checks `<BASE_URL>/health`) to hear about the server being
   down altogether.

Restart the app after editing `.env`: `docker compose up -d`, or `pm2 reload postfalcon --update-env`.

### Social platforms at a glance

| Platform        | Needs a developer app? | Worth knowing                                                                 |
| --------------- | ---------------------- | ----------------------------------------------------------------------------- |
| Mastodon        | No                     | Works with any server                                                         |
| Bluesky         | No                     | Users connect with an app password                                            |
| Telegram        | No                     | Users connect their own bot to a channel                                      |
| Facebook, Instagram | Yes (one Meta app) | Other people can connect only after Meta's App Review and business verification |
| Threads         | Yes (separate Meta app) | Same App Review process                                                      |
| YouTube         | Yes (Google Cloud)     | Unverified apps only allow listed test users; uploads are private until Google's YouTube API audit |
| TikTok          | Yes                    | Posts are private until TikTok's Direct Post audit                           |
| Pinterest       | Yes                    | Needs Standard access for real Pins (Trial access only reaches the sandbox)   |
| LinkedIn        | Yes                    | The app must be linked to a LinkedIn Company Page; text posts only            |
| X               | Yes                    | Posting requires a paid X API plan                                            |

The review processes are run by each platform and can take days or weeks. Until a review
passes, you can usually still connect and post from your own account, which is often all
a personal server needs.

---

## Selling plans (optional)

Without a Stripe key, the server is **self-hosted**: every account gets every feature, with no
limits, and there are no pricing pages. To sell subscriptions the way postfalcon.co does:

1. Set the plans and prices in [`lib/billing.js`](lib/billing.js).
2. Put `STRIPE_SECRET_KEY` in `.env` and run `npm run stripe:setup`. With Docker:
   `docker compose exec app npm run stripe:setup`. It creates the products, prices, customer
   portal settings and webhook, and prints the webhook secret.
3. Put that secret in `STRIPE_WEBHOOK_SECRET` and restart.

New accounts then get a 7-day trial and pick a plan through Stripe Checkout.

---

## API and AI agents

- REST API: documented at `/api-docs` on your server. Create a token under **Settings → API
  access for agents**.
- MCP server, for AI assistants:
  - URL-based clients (ChatGPT, Claude.ai, Cursor): connect to `<BASE_URL>/mcp` with the
    header `Authorization: Bearer <your token>`.
  - Local clients (Claude Desktop, Cursor's `command` setting): run `npm run mcp` with
    `POSTFALCON_BASE_URL` and `POSTFALCON_API_TOKEN` set.

---

## Development

```bash
npm install
cp .env.example .env    # BASE_URL=http://localhost:3000, NODE_ENV empty, your local DATABASE_URL
npm run migrate
npm run dev
```

[`CLAUDE.md`](CLAUDE.md) describes the architecture and the conventions the code follows.

### Running the tests

The tests ([Vitest](https://vitest.dev) + Supertest) run against a **real PostgreSQL
database**, not mocks, so they need one of their own. Every test empties its tables, so never
point it at a database you care about.

1. Create an empty test database, once:

   ```bash
   createdb postfalcon_test          # or: psql -c 'CREATE DATABASE postfalcon_test'
   ```

2. Create `.env.test` in the project root (it's git-ignored):

   ```
   DATABASE_URL=postgresql://postgres:password@localhost:5432/postfalcon_test
   SESSION_SECRET=any-test-secret
   BASE_URL=http://localhost:3000
   ```

   Nothing else is needed. The suite fills in placeholder keys for every social platform, runs
   with no Stripe key (self-hosted mode; billing tests set their own), and creates the tables
   itself by running the migrations.

3. Run them:

   ```bash
   npm test                                   # everything (about a minute)
   npx vitest run tests/pinterest.test.js     # one file
   npx vitest run -t "board picker"           # tests whose name matches
   npx vitest                                 # watch mode: re-runs on save
   ```

No test talks to a real social platform, Stripe or an SMTP server: outgoing HTTP calls are
stubbed in each test and email is mocked. Test files run one at a time because they share the
database. There's one file per route file (`routes/x.js` → `tests/x.test.js`), plus
`tests/scheduler.test.js` for publishing; [`tests/setup.js`](tests/setup.js) is the shared setup.

## License

[GNU Affero General Public License v3.0](LICENSE) or later. You're free to use, change and
self-host Postfalcon. If you offer a modified version to other people over a network, you
must make your changes available to them under the same license.
