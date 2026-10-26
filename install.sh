#!/bin/sh
# Postfalcon one-line installer:
#
#   curl -fsSL https://postfalcon.co/install.sh | sh
#
# Sets up Postfalcon with Docker in ~/postfalcon: checks Docker (offering to install it), asks
# for the domain, generates the secrets, downloads the compose file and starts the published
# image (ghcr.io/natewhi/postfalcon). Nothing else on the machine is changed. Read it first if
# you like: it's short, and README.md has the same steps by hand.
#
# Settings (all optional), e.g. POSTFALCON_DOMAIN=social.example.com sh install.sh
#   POSTFALCON_DOMAIN  skip the domain question
#   POSTFALCON_DIR     where to install (default ~/postfalcon)
#   POSTFALCON_REF     branch or tag of the repository to take the files from (default main)
set -eu

REPO_RAW="https://raw.githubusercontent.com/natewhi/postfalcon"
REF="${POSTFALCON_REF:-main}"
DIR="${POSTFALCON_DIR:-$HOME/postfalcon}"
DOMAIN="${POSTFALCON_DOMAIN:-}"

say() { printf '%s\n' "$*"; }
fail() {
  printf '\nError: %s\n' "$*" >&2
  exit 1
}
# Questions come from the terminal, not stdin, which is this script when piped from curl.
ask() {
  REPLY=""
  if [ -r /dev/tty ]; then
    printf '%s' "$1" >/dev/tty
    read -r REPLY </dev/tty || REPLY=""
  fi
}
random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

say "Postfalcon installer"
say ""

# 1. Docker -----------------------------------------------------------------------------------
command -v curl >/dev/null 2>&1 || fail "curl is needed (sudo apt install curl)."

if ! command -v docker >/dev/null 2>&1; then
  say "Docker isn't installed."
  ask "Install it now with Docker's official script? It needs sudo. [Y/n] "
  case "$REPLY" in
    n | N | no | No) fail "Install Docker first (https://docs.docker.com/engine/install/), then run this again." ;;
  esac
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$(id -un)" || true
fi

DOCKER="docker"
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    DOCKER="sudo docker"
    say "Using sudo for Docker this time. To run docker without sudo later: log out and back in"
    say "(your user was added to the docker group), or run: sudo usermod -aG docker $(id -un)"
    say ""
  else
    fail "Can't reach Docker. Is it running? Try: sudo systemctl start docker"
  fi
fi
$DOCKER compose version >/dev/null 2>&1 ||
  fail "This needs Docker Compose v2 (the 'docker compose' command). Update Docker: https://docs.docker.com/engine/install/"

# 2. An existing install is never touched -------------------------------------------------------
if [ -f "$DIR/.env" ]; then
  say "Postfalcon is already installed in $DIR, so nothing was changed."
  say "To update it:  cd $DIR && $DOCKER compose pull && $DOCKER compose up -d"
  exit 0
fi

# 3. The address --------------------------------------------------------------------------------
if [ -z "$DOMAIN" ]; then
  say "Which address will people use to reach Postfalcon?"
  say "  - a domain whose DNS points at this server, e.g. social.example.com"
  say "  - or, just to try it out, this machine's IP address or localhost"
  ask "Domain or IP address: "
  DOMAIN="$REPLY"
fi
# Accept a pasted URL too: drop the scheme, any path, and spaces.
DOMAIN=$(printf '%s' "$DOMAIN" | tr -d '[:space:]' | sed -e 's#^[A-Za-z]*://##' -e 's#/.*$##')
[ -n "$DOMAIN" ] || fail "A domain or IP address is needed. Run again, or set POSTFALCON_DOMAIN."
case "$DOMAIN" in
  *[!A-Za-z0-9.-]*) fail "\"$DOMAIN\" doesn't look like a domain or IP address." ;;
esac

# 4. Files and settings -------------------------------------------------------------------------
say ""
say "Installing into $DIR"
mkdir -p "$DIR"
cd "$DIR"
fetch() {
  curl -fsSL "$REPO_RAW/$REF/$1" -o "$2" || fail "Couldn't download $1 from $REPO_RAW/$REF"
}
fetch deploy/docker-compose.image.yml docker-compose.yml
fetch deploy/Caddyfile.docker Caddyfile
fetch .env.example .env.example

SESSION_SECRET=$(random_hex 32)
POSTGRES_PASSWORD=$(random_hex 16)
# .env.example with the REQUIRED section filled in; everything else stays as documented there.
umask 077
sed -e "s#^BASE_URL=.*#BASE_URL=https://$DOMAIN#" \
  -e "s#^DOMAIN=.*#DOMAIN=$DOMAIN#" \
  -e "s#^SESSION_SECRET=.*#SESSION_SECRET=$SESSION_SECRET#" \
  -e "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$POSTGRES_PASSWORD#" \
  .env.example >.env
umask 022
grep -q "^SESSION_SECRET=$SESSION_SECRET\$" .env && grep -q "^POSTGRES_PASSWORD=$POSTGRES_PASSWORD\$" .env ||
  fail "Couldn't write the settings to $DIR/.env."

# 5. Start ---------------------------------------------------------------------------------------
say "Downloading and starting Postfalcon (the first time takes a minute or two)..."
$DOCKER compose pull --quiet
$DOCKER compose up -d

say "Waiting for it to be ready..."
i=0
status=""
while [ "$i" -lt 60 ]; do
  container=$($DOCKER compose ps -q app 2>/dev/null || true)
  if [ -n "$container" ]; then
    status=$($DOCKER inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)
  fi
  [ "$status" = "healthy" ] && break
  i=$((i + 1))
  sleep 2
done

say ""
if [ "$status" != "healthy" ]; then
  say "Postfalcon started but isn't answering yet. Its log so far:"
  $DOCKER compose logs app --tail 30 || true
  say ""
  say "Check again in a minute with:  cd $DIR && $DOCKER compose ps"
  exit 1
fi

say "Postfalcon is running."
say ""
say "  Open https://$DOMAIN and choose Sign up."
say "  The first account becomes the admin, so create yours now."
say ""
case "$DOMAIN" in
  localhost | *[0-9].*[0-9].*[0-9].*[0-9])
    say "  Your browser will warn about the certificate (a local one, for an IP address or"
    say "  localhost). That's expected: choose to continue."
    ;;
  *)
    say "  For the HTTPS certificate, $DOMAIN must point at this server and ports 80 and 443"
    say "  must be reachable from the internet. If the page doesn't load, check:"
    say "    cd $DIR && $DOCKER compose logs caddy --tail 20"
    ;;
esac
say ""
say "  Files and settings:  $DIR (.env holds the settings, and the passwords it generated)"
say "  Update later:        cd $DIR && $DOCKER compose pull && $DOCKER compose up -d"
say "  Logs:                cd $DIR && $DOCKER compose logs -f app"
say "  Next steps:          https://github.com/natewhi/postfalcon#after-installing"
