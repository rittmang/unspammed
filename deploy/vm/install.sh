#!/bin/sh
# Manual VM installation using Docker Engine and Compose. Run as root or with sudo:
#   cp deploy/vm/app.env.example app.env   # edit it first
#   sh deploy/vm/install.sh
set -eu
cd -P "$(dirname "$0")/../.."

# Validate the selected input before installing anything or invoking Docker.
ENV_FILE="${WATCHTOWER_VM_ENV:-${WATCHTOWER_ENV_FILE:-app.env}}"
if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
  echo "Missing regular private input file. Copy deploy/vm/app.env.example to app.env and set your values." >&2
  exit 1
fi
ENV_FILE="$(cd -P "$(dirname "$ENV_FILE")" && pwd -P)/$(basename "$ENV_FILE")"
if [ -L .watchtower ]; then
  echo "Refusing to write private output through a symbolic link." >&2
  exit 1
fi
# The temporary Node image intentionally contains no Git client, so enforce the
# ignore boundary on the host before generating credentials in that container.
if git_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  for private_path in "$ENV_FILE" "$PWD/.watchtower/runtime.env" "$PWD/.watchtower/compose.env" "$PWD/.watchtower/secrets.json" "$PWD/.watchtower/setup.json"; do
    case "$private_path" in
      "$git_root"/*)
        if ! git check-ignore --quiet -- "$private_path" || git ls-files --error-unmatch -- "$private_path" >/dev/null 2>&1; then
          echo "A private setup path is tracked or not ignored by Git. Add its exact path to the ignore rules first." >&2
          exit 1
        fi
        ;;
    esac
  done
fi

if ! command -v docker >/dev/null 2>&1; then
  if [ "$(uname -s)" != Linux ] || [ "$(id -u)" -ne 0 ]; then
    echo "Install Docker Engine and the Compose plugin first, or run as root on Linux." >&2
    exit 1
  fi
  echo "Installing Docker..."
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  curl -fsSL https://get.docker.com -o "$installer"
  sh "$installer"
  rm -f "$installer"
  trap - EXIT HUP INT TERM
fi
docker compose version >/dev/null
docker info >/dev/null

echo "Preparing private runtime configuration..."
docker run --rm -v "$PWD:/app" -v "$ENV_FILE:$ENV_FILE" -w /app \
  -e "WATCHTOWER_ENV_FILE=$ENV_FILE" node:22-bookworm-slim node deploy/vm/configure.mjs

# Compose gives exported shell values precedence over --env-file. Use the same
# selected private inputs for generation and deployment, regardless of an older
# shell's profile/password/port settings. Keep the Docker connection and explicit
# project namespace available to operators and isolated verification projects.
unset COMPOSE_FILE COMPOSE_ENV_FILES COMPOSE_PROFILES POSTGRES_PASSWORD \
  WATCHTOWER_DATABASE_PASSWORD WATCHTOWER_BIND WATCHTOWER_PORT WATCHTOWER_DOMAIN

compose() {
  docker compose --env-file .watchtower/compose.env "$@"
}
compose config --quiet
echo "Building Watchtower..."
compose build watchtower
if compose config --services | grep -qx db; then
  echo "Starting the private database..."
  compose up -d --wait db
fi

echo "Initializing the application schema without replacing existing data..."
# Only this short-lived bootstrap container can read DATABASE_ADMIN_URL. It is
# excluded from the normal service environment by the shared setup generator.
# The host file is root-owned 0600 on a fresh VM; only this bootstrap process
# runs as root inside its container so the normal unprivileged app need not read it.
compose run --rm --no-deps --user 0:0 -v "$ENV_FILE:/run/watchtower-bootstrap.env:ro" \
  -e WATCHTOWER_ENV_FILE=/run/watchtower-bootstrap.env watchtower \
  node --import tsx scripts/database-setup.ts
echo "Starting Watchtower..."
compose up -d --wait
echo "Done. Check: docker compose --env-file .watchtower/compose.env ps"
echo "Verify your public HTTPS /health, then run the documented Telegram checks inside the app container."
