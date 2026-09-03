#!/usr/bin/env bash
set -euo pipefail
export PATH="$PATH:/usr/local/go/bin"

sudo docker rm -f bitswan-automation-server-daemon traefik bitswan-protected-proxy \
  bitswan-protected-proxy-redis bitswan-e2e-keycloak bitswan-e2e-otel >/dev/null 2>&1 || true
sudo docker volume rm bitswan >/dev/null 2>&1 || true

cd /repo
E2E_SKIP_WORKSPACE_IMAGES=1 \
E2E_KC_DOMAIN="${E2E_KC_DOMAIN:-bs-idp.test}" \
  bash e2e/bringup.sh

cd /repo/e2e
npx playwright test tests/device-trust.spec.ts --reporter=list
