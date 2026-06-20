#!/usr/bin/env bash
# Raw QEMU/KVM runner (no Vagrant): boot a disposable Ubuntu cloud-image guest
# with hardware acceleration, sync THIS repo in, run the full real-stack
# BP-lifecycle E2E, and copy the Playwright report back to e2e/playwright-report.
#
# Host prereqs: qemu-system-x86_64, cloud-image-utils (cloud-localds), ssh,
# rsync, and /dev/kvm (hardware virtualization). On Debian/Ubuntu:
#   sudo apt-get install -y qemu-system-x86 cloud-image-utils openssh-client rsync
#
# Usage (from e2e/local-vm/):  ./run-qemu.sh   (add --keep to leave the VM up)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${TMPDIR:-/tmp}/bitswan-e2e-vm"
CPUS="${E2E_VM_CPUS:-8}"
MEM_MB="${E2E_VM_MEMORY_MB:-8192}"
SSH_PORT=2222
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1

[ -e /dev/kvm ] || { echo "ERROR: /dev/kvm not present — enable virtualization (this is the whole point of running locally)."; exit 1; }
mkdir -p "$WORK"

echo "=== fetch Ubuntu 24.04 cloud image (cached) ==="
IMG="$WORK/noble-server-cloudimg-amd64.img"
[ -f "$IMG" ] || curl -fsSL -o "$IMG" \
  https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
OVERLAY="$WORK/disk.qcow2"
qemu-img create -f qcow2 -F qcow2 -b "$IMG" "$OVERLAY" 60G >/dev/null

echo "=== ssh key + cloud-init seed ==="
KEY="$WORK/id_ed25519"
[ -f "$KEY" ] || ssh-keygen -t ed25519 -N '' -f "$KEY" -q
PUB="$(cat "$KEY.pub")"
cat > "$WORK/user-data" <<EOF
#cloud-config
hostname: bitswan-e2e
users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys: [ "$PUB" ]
ssh_pwauth: false
EOF
echo "instance-id: bitswan-e2e" > "$WORK/meta-data"
cloud-localds "$WORK/seed.iso" "$WORK/user-data" "$WORK/meta-data"

echo "=== boot KVM guest ($CPUS vCPU, ${MEM_MB}MB) ==="
qemu-system-x86_64 -enable-kvm -cpu host -smp "$CPUS" -m "$MEM_MB" \
  -nographic -serial none -monitor none \
  -drive file="$OVERLAY",if=virtio,format=qcow2 \
  -drive file="$WORK/seed.iso",if=virtio,format=raw \
  -netdev user,id=n0,hostfwd=tcp::${SSH_PORT}-:22 -device virtio-net-pci,netdev=n0 \
  -daemonize -pidfile "$WORK/qemu.pid"

cleanup() { [ "$KEEP" = 1 ] || { kill "$(cat "$WORK/qemu.pid")" 2>/dev/null || true; }; }
trap cleanup EXIT

SSH="ssh -p $SSH_PORT -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5"
echo "=== wait for SSH ==="
for i in $(seq 1 60); do $SSH ubuntu@127.0.0.1 true 2>/dev/null && break; sleep 5; \
  [ "$i" = 60 ] && { echo "ERROR: guest SSH never came up"; exit 1; }; done

echo "=== sync repo into guest ==="
$SSH ubuntu@127.0.0.1 'sudo mkdir -p /repo && sudo chown ubuntu /repo'
rsync -a -e "$SSH" --exclude node_modules --exclude .git --exclude 'dist/' \
  --exclude 'e2e/playwright-report/' "$REPO_ROOT/" ubuntu@127.0.0.1:/repo/

echo "=== provision + run E2E in guest ==="
$SSH ubuntu@127.0.0.1 'sudo bash /repo/e2e/local-vm/provision.sh'
# Re-login so the docker group membership applies, then run the suite.
$SSH ubuntu@127.0.0.1 'bash /repo/e2e/local-vm/run-e2e.sh' || RC=$? || true

echo "=== copy the Playwright report back ==="
rsync -a -e "$SSH" ubuntu@127.0.0.1:/repo/e2e/playwright-report/ \
  "$REPO_ROOT/e2e/playwright-report/" 2>/dev/null || true

[ "$KEEP" = 1 ] && echo "VM left running: $SSH ubuntu@127.0.0.1"
exit "${RC:-0}"
