#!/bin/sh
# One-command install on any Linux VM (DigitalOcean Droplet, Google
# Compute Engine, Azure VM, AWS Lightsail/EC2, Hetzner, Linode, Vultr,
# Oracle, or your own server). Run as root or with sudo:
#   cp deploy/vm/app.env.example app.env   # edit it first
#   sh deploy/vm/install.sh
set -eu
cd "$(dirname "$0")/../.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null

ENV_FILE="${WATCHTOWER_VM_ENV:-app.env}"
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Copy deploy/vm/app.env.example to app.env and set your values." >&2
  exit 1
fi
if [ ! -f .watchtower/runtime.env ]; then
  echo "Generating private runtime configuration..."
  docker run --rm -v "$PWD:/app" -w /app --env-file "$ENV_FILE" node:22-alpine \
    node scripts/setup.mjs --provider railway --browser-auth
fi

echo "Building and starting Watchtower..."
docker compose up -d --build
echo "Done. Check: docker compose ps  and  curl http://127.0.0.1:3000/health"
echo "Then, on your own computer: npm run setup:check && npm run telegram:setup && npm run telegram:mini-app"
