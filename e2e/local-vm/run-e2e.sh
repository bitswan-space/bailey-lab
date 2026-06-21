#!/usr/bin/env bash
# Run the real-stack BP-lifecycle E2E inside the provisioned guest: bring the
# whole stack up (e2e/bringup.sh) then run the Playwright suite. The HTML report
# lands in /repo/e2e/playwright-report (synced back to the host by Vagrant).
set -euo pipefail
export PATH="$PATH:/usr/local/go/bin"

# Step profiler: continuous timeline across this script + bringup.sh. The host
# runner (run-qemu.sh) keeps its own timeline for boot/rsync/provision and merges
# them at the end.
source /repo/e2e/local-vm/timeline.sh
tl_begin

cd /repo
echo "=== bring up the real bitswan stack (+ disposable Keycloak) ==="
# bringup.sh sources timeline.sh too and adds per-build-step marks; it continues
# THIS timeline (shared state file), so do not tl_begin again in there.
bash e2e/bringup.sh

echo "=== install + run Playwright ==="
cd /repo/e2e
npm ci || npm install
mark "e2e: npm ci (Playwright deps)"
npx playwright install --with-deps chromium
mark "e2e: playwright install chromium"
npm test || true   # always build the manual even if a chapter fails the SLA
# No aggregate mark here — the walkthrough records its OWN per-chapter timings
# into the same timeline (walkthrough: <chapter>), so the slowest-first profile
# pinpoints which user-facing step is slow. An aggregate would double-count them.

echo "=== generate the Operator's Handbook from the captured screenshots ==="
node manual/generate.mjs || true
mark "e2e: generate handbook"
ls -la /repo/e2e/manual/build/ 2>/dev/null || true

tl_profile
