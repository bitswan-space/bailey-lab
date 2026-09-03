#!/usr/bin/env bash
set -euo pipefail
export PATH="$PATH:/usr/local/go/bin"
source /repo/e2e/local-vm/timeline.sh
tl_begin
cd /repo
bash e2e/bringup.sh
docker ps --format '{{.Names}}\t{{.Status}}'
tl_profile
