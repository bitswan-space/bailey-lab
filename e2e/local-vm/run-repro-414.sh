#!/usr/bin/env bash
set -euo pipefail
export PATH="$PATH:/usr/local/go/bin"

source /repo/e2e/local-vm/timeline.sh
tl_begin

cd /repo
E2E_SKIP_WORKSPACE_IMAGES=1 \
E2E_KC_DOMAIN="${E2E_KC_DOMAIN:-bs-idp.test}" \
  bash e2e/bringup.sh

cd /repo/e2e
npm ci || npm install
mark "e2e: npm ci"
for attempt in 1 2 3; do
  npx playwright install --with-deps chromium && break
  echo "playwright install attempt $attempt failed; retrying..." >&2
  sleep 5
done
mark "e2e: playwright install chromium"

npx playwright test tests/device-trust.spec.ts --reporter=list
