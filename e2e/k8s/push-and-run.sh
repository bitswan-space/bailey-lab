#!/usr/bin/env bash
# Mirror this checkout to the sandbox and start a cycle on the k3s guest.
#
# Absolute paths throughout, and the repo root derived from this file rather
# than from the caller's working directory: a relative "./" here once synced the
# wrong subtree with --delete and destroyed the e2e tree on the far side.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="${BITSWAN_SANDBOX:-root@sandbox.bitswan.ai}"

rsync -az --delete \
  --exclude node_modules --exclude .git --exclude serverconsole_dist \
  --exclude 'e2e/manual/build' --exclude 'e2e/playwright-report' --exclude 'e2e/test-results' \
  "$ROOT/" "$SANDBOX:/root/bailey-k8s-ci/"

# A sanity check on the far side before anything is launched against it: the
# mirror having the wrong shape is the failure this script exists to prevent,
# and it is cheaper to catch here than as a cycle that cannot find its own
# scripts.
ssh "$SANDBOX" 'test -f /root/bailey-k8s-ci/e2e/k8s/rebuild-and-run.sh' ||
  { echo "the sandbox mirror is not a repo root; refusing to launch" >&2; exit 1; }

ssh "$SANDBOX" 'nohup bash /root/launch-k8s-cycle.sh > /root/k8s-launch.log 2>&1 &'
echo "launched; watch /tmp/current-run.log on the guest"
