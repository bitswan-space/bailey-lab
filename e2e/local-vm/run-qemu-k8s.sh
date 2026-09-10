#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FREE_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
if [ "$FREE_GB" -lt "${E2E_MIN_FREE_GB:-60}" ]; then
  echo "refusing to boot: ${FREE_GB}G free on /, need ${E2E_MIN_FREE_GB:-60}G" >&2
  exit 1
fi
AVAIL_MB=$(free -m | awk '/^Mem:/{print $7}')
if [ "$AVAIL_MB" -lt "${E2E_MIN_AVAIL_MB:-16000}" ]; then
  echo "refusing to boot: ${AVAIL_MB}M RAM available, need ${E2E_MIN_AVAIL_MB:-16000}M" >&2
  exit 1
fi

exec 8>/var/lock/bitswan-e2e-kvm.global.lock
if ! flock -n 8; then
  echo "another bitswan KVM e2e run holds the global lock — exiting." >&2
  exit 0
fi

export TMPDIR="${E2E_K8S_WORK:-/root/bitswan-k8s-vm-work}"
mkdir -p "$TMPDIR/bitswan-e2e-vm"

SRC=/tmp/bitswan-e2e-vm/noble-server-cloudimg-amd64.img
DST="$TMPDIR/bitswan-e2e-vm/noble-server-cloudimg-amd64.img"
if [ ! -f "$DST" ] && [ -f "$SRC" ]; then ln "$SRC" "$DST" 2>/dev/null || true; fi

export E2E_VM_IP="${E2E_VM_IP:-192.168.122.90}"
export E2E_VM_MAC="${E2E_VM_MAC:-52:54:00:e2:e0:90}"
export E2E_VM_CPUS="${E2E_VM_CPUS:-8}"
export E2E_VM_MEMORY_MB="${E2E_VM_MEMORY_MB:-14336}"
export E2E_GUEST_PROVISION=/repo/e2e/local-vm/provision-k8s.sh
export E2E_GUEST_RUN="${E2E_GUEST_RUN:-/repo/e2e/local-vm/run-k8s-e2e.sh}"

exec "$HERE/run-qemu.sh" "$@"
