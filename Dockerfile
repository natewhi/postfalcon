# Postfalcon app image. docker-compose.yml runs it next to Postgres and Caddy; see README.md.
FROM node:22-alpine

# pg_dump for the nightly backups (lib/backup.js); must match the Postgres major version in
# docker-compose.yml (16).
RUN apk add --no-cache postgresql16-client

WORKDIR /app

# Dependencies first so they're cached between code changes. postinstall copies the
# self-hosted FullCalendar bundle into public/vendor, so it needs its script.
COPY package.json package-lock.json ./
COPY scripts/copy-vendor.js scripts/copy-vendor.js
RUN npm ci --omit=dev

COPY . .

# The app runs as the unprivileged `node` user, so everything it ships must be readable by it
# whatever permissions the files had on the machine that built the image (a strict umask, or a
# copy that kept private 600 modes, otherwise fails at start with EACCES). Uploaded media and
# backups live on volumes; the image creates those directories so a fresh named volume starts
# out owned by `node`.
RUN chmod -R a+rX /app \
  && mkdir -p public/uploads backups \
  && chown -R node:node public/uploads backups
USER node

ENV NODE_ENV=production PORT=3000
EXPOSE 3000

# The commit this image was built from, passed by the publishing workflow
# (.github/workflows/docker-image.yml) for Admin -> Overview -> Version. Empty for a local build,
# which then reads it from the .git files instead (lib/version.js).
ARG APP_COMMIT=
ENV APP_COMMIT=$APP_COMMIT
LABEL org.opencontainers.image.source="https://github.com/natewhi/postfalcon" \
      org.opencontainers.image.description="Open-source social media scheduler" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3000/health > /dev/null || exit 1

# Pending migrations, then the app (the scheduler runs in this same process: run one container).
CMD ["sh", "-c", "node db/migrate.js && node index.js"]
