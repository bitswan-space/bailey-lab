#!/usr/bin/env bash
# Run the real-stack BP-lifecycle E2E inside the provisioned guest: bring the
# whole stack up (e2e/bringup.sh) then run the Playwright suite. The HTML report
# lands in /repo/e2e/playwright-report (synced back to the host by Vagrant).
set -euo pipefail
export PATH="$PATH:/usr/local/go/bin"

cd /repo
echo "=== bring up the real bitswan stack (+ disposable Keycloak) ==="
bash e2e/bringup.sh

echo "=== install + run Playwright ==="
cd /repo/e2e
npm ci || npm install
npx playwright install --with-deps chromium
npm test
