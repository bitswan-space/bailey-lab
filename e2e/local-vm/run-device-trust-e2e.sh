#!/usr/bin/env bash
set -euo pipefail
export PATH="$PATH:/usr/local/go/bin"

sudo docker rm -f bitswan-automation-server-daemon traefik bitswan-protected-proxy \
  bitswan-protected-proxy-redis bitswan-e2e-keycloak bitswan-e2e-otel >/dev/null 2>&1 || true
sudo docker volume rm bitswan >/dev/null 2>&1 || true
if sudo docker volume inspect bitswan >/dev/null 2>&1; then
  echo "ERROR: the bitswan volume survived; this server is still claimed and the suite needs an unclaimed one." >&2
  sudo docker ps -a --filter volume=bitswan --format '  still mounted by: {{.Names}}' >&2
  exit 1
fi

cd /repo
E2E_SKIP_WORKSPACE_IMAGES=1 \
E2E_KC_DOMAIN="${E2E_KC_DOMAIN:-bs-idp.test}" \
  bash e2e/bringup.sh

cd /repo/e2e
npm ci || npm install
for attempt in 1 2 3; do
  npx playwright install --with-deps chromium && break
  echo "playwright install attempt $attempt failed; retrying..." >&2
  sleep 5
done

npx playwright test -c playwright.device-trust.config.ts --reporter=list
