#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="${BITSWAN_SANDBOX:-root@sandbox.bitswan.ai}"

rsync -az --delete \
  --exclude node_modules --exclude .git --exclude serverconsole_dist \
  --exclude 'e2e/manual/build' --exclude 'e2e/playwright-report' --exclude 'e2e/test-results' \
  "$ROOT/" "$SANDBOX:/root/bailey-k8s-ci/"

ssh "$SANDBOX" 'test -f /root/bailey-k8s-ci/e2e/k8s/rebuild-and-run.sh' ||
  { echo "the sandbox mirror is not a repo root; refusing to launch" >&2; exit 1; }

ssh "$SANDBOX" 'nohup bash /root/launch-k8s-cycle.sh > /root/k8s-launch.log 2>&1 &'
echo "launched; watch /tmp/current-run.log on the guest"
