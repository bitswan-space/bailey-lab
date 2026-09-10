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
# Retry: `--with-deps` runs apt-get update, which can transiently 403 when
# archive.ubuntu.com load-balances onto a stale/bad mirror (especially via a
# proxy). Retry a few times so a flaky mirror doesn't fail the whole run.
for attempt in 1 2 3; do
  npx playwright install --with-deps chromium && break
  echo "playwright install attempt $attempt failed; retrying..." >&2
  sleep 5
done
mark "e2e: playwright install chromium"
# The walkthrough's verdict IS this run's verdict: run-qemu.sh propagates our
# exit status, so swallowing it (this was `npm test || true`) threw away every
# regression the suite exists to catch. It is RECORDED rather than propagated
# here so the two steps below still run — the handbook built from whatever
# screenshots the run did capture is the most useful thing a failed run leaves
# behind, and the timeline profile is how a slow chapter gets found at all.
test_rc=0
npm test || test_rc=$?
# No aggregate mark here — the walkthrough records its OWN per-chapter timings
# into the same timeline (walkthrough: <chapter>), so the slowest-first profile
# pinpoints which user-facing step is slow. An aggregate would double-count them.

echo "=== generate the Operator's Handbook from the captured screenshots ==="
# A missing screenshot is not an error here (generate.mjs renders that slot
# empty), so a failure means the generator itself is broken — a syntax error in
# content.mjs, or the Paged.js polyfill absent. Nothing else in the tree catches
# that, so it fails the run too.
manual_rc=0
node manual/generate.mjs || manual_rc=$?
mark "e2e: generate handbook"
ls -la /repo/e2e/manual/build/ 2>/dev/null || true

tl_profile

[ "$test_rc" = 0 ] || echo "FAILED: the Playwright walkthrough exited $test_rc" >&2
[ "$manual_rc" = 0 ] || echo "FAILED: handbook generation exited $manual_rc" >&2
[ "$test_rc" = 0 ] || exit "$test_rc"
exit "$manual_rc"
