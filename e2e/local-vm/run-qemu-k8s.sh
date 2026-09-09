#!/usr/bin/env bash
# Boot the Kubernetes-namespace Bailey guest: run-qemu.sh with the four settings
# that keep it out of the shared Docker guest's way, plus the two preflights that
# a shared host needs.
#
# Isolation comes from TMPDIR: run-qemu.sh derives WORK — and therefore its
# singleton lock, ssh keys, cloud image and overlay disk — from it, so a separate
# TMPDIR is a separate VM with a separate lock and nothing in run-qemu.sh has to
# know this flavour exists. The IP and MAC must differ too, or two guests fight
# over one address and both lose their networking.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The host also runs a live Bailey, the shared Docker e2e guest and unrelated
# repro guests. Refuse to start rather than fill the filesystem mid-run: a
# half-written qcow2 corrupts this guest AND wedges every other one on the box.
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

# run-qemu.sh's lock lives inside WORK, so per-flavour work dirs each get their
# own and would happily boot together on a 12-core host. One KVM e2e at a time,
# whichever flavour, and the lock is held for the whole run.
exec 8>/var/lock/bitswan-e2e-kvm.global.lock
if ! flock -n 8; then
  echo "another bitswan KVM e2e run holds the global lock — exiting." >&2
  exit 0
fi

export TMPDIR="${E2E_K8S_WORK:-/root/bitswan-k8s-vm-work}"
mkdir -p "$TMPDIR/bitswan-e2e-vm"

# Hardlink the cached cloud image instead of re-downloading 622 MB into a fresh
# work dir. qemu opens a backing file read-only, so sharing the inode is safe,
# and run-qemu.sh only fetches when the file is absent.
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
