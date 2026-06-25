#!/usr/bin/env bash
# Raw QEMU/KVM runner: boot a disposable Ubuntu cloud-image guest, sync THIS repo
# in, run the full real-stack walkthrough + generate the Operator's Handbook, and
# copy it back. The guest is attached to libvirt's NAT bridge (virbr0) for
# near-native network speed — slirp/usermode networking is far too slow for the
# real image pulls + builds the deploy lifecycle does.
#
# Host prereqs (Debian/Ubuntu):
#   apt-get install -y qemu-system-x86 qemu-utils cloud-image-utils \
#                      libvirt-daemon-system openssh-client rsync
#   # virbr0 active (virsh net-start default) + /etc/qemu/bridge.conf: allow virbr0
#
# Usage (from e2e/local-vm/):  ./run-qemu.sh   (add --keep to leave the VM up)
set -euo pipefail

WORK="${TMPDIR:-/tmp}/bitswan-e2e-vm"

# Single-instance guard: re-exec ourselves holding an exclusive, non-blocking
# flock so a SECOND concurrent run-qemu can never start and wipe a running VM's
# disk out from under it (a stray duplicate launch just no-ops instead of
# reaping the active run). The FLOCKED env marker prevents an infinite re-exec.
mkdir -p "$WORK"
if [ -z "${RUNQEMU_FLOCKED:-}" ]; then
  exec env RUNQEMU_FLOCKED=1 flock -n "$WORK/run-qemu.singleton.lock" "$0" "$@" || {
    echo "another run-qemu is already running (singleton lock held) — exiting."; exit 0;
  }
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CPUS="${E2E_VM_CPUS:-8}"
MEM_MB="${E2E_VM_MEMORY_MB:-8192}"
BRIDGE="${E2E_VM_BRIDGE:-virbr0}"
VM_IP="${E2E_VM_IP:-192.168.122.50}"
VM_GW="${E2E_VM_GW:-192.168.122.1}"
VM_MAC="52:54:00:e2:e0:01"
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1

[ -e /dev/kvm ] || { echo "ERROR: /dev/kvm not present — enable virtualization."; exit 1; }
ip link show "$BRIDGE" >/dev/null 2>&1 || { echo "ERROR: bridge $BRIDGE missing (start libvirt 'default' net)."; exit 1; }

# Ensure libvirt's NAT/forward rules for the guest subnet are present. Docker
# rewrites iptables when it (re)configures bridges and routinely flushes
# libvirt's MASQUERADE rule for 192.168.122.0/24 out from under it — the guest
# then boots fine but has NO outbound internet, so apt/docker pulls fail with
# "Temporary failure resolving …" and provisioning dies. Re-assert the default
# network so its rules are reinstalled (idempotent; no-op if already correct).
if [ "$BRIDGE" = "virbr0" ] && command -v virsh >/dev/null 2>&1; then
  if ! sudo iptables -t nat -S 2>/dev/null | grep -q '192.168.122.0/24.*MASQUERADE'; then
    echo "--- libvirt NAT for guest subnet missing; restarting 'default' network ---"
    sudo virsh net-destroy default >/dev/null 2>&1 || true
    sudo virsh net-start default  >/dev/null 2>&1 || true
  fi
fi

# Step profiler for the HOST-side phases (boot / rsync / provision / run / copy).
# The guest keeps its own timeline (build steps, test, manual gen); both are
# merged into one slowest-first profile at the end.
mkdir -p "$WORK"
export TL_FILE="$WORK/timeline-host.tsv" TL_STATE="$WORK/.tl-host-state"
source "$(dirname "${BASH_SOURCE[0]}")/timeline.sh"
tl_begin

# On hosts that also run Docker, Docker sets the FORWARD policy to DROP, which
# strangles the bridged guest's NAT (throughput collapses to ~1 KB/s). Insert
# ACCEPT rules for the bridge ABOVE Docker's chains (idempotent, additive — does
# not touch Docker's own rules). This is what makes the guest's network usable.
if command -v iptables >/dev/null 2>&1; then
  iptables -C FORWARD -i "$BRIDGE" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -i "$BRIDGE" -j ACCEPT || true
  iptables -C FORWARD -o "$BRIDGE" -j ACCEPT 2>/dev/null || iptables -I FORWARD 1 -o "$BRIDGE" -j ACCEPT || true
fi
mkdir -p "$WORK"

echo "=== fetch Ubuntu 24.04 cloud image (cached) ==="
IMG="$WORK/noble-server-cloudimg-amd64.img"
[ -f "$IMG" ] || curl -fsSL -o "$IMG" \
  https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img
mark "host: fetch Ubuntu cloud image (cached)"
OVERLAY="$WORK/disk.qcow2"
qemu-img create -f qcow2 -F qcow2 -b "$IMG" "$OVERLAY" 60G >/dev/null

echo "=== ssh key + cloud-init seed (static IP $VM_IP on $BRIDGE) ==="
KEY="$WORK/id_ed25519"
[ -f "$KEY" ] || ssh-keygen -t ed25519 -N '' -f "$KEY" -q
PUB="$(cat "$KEY.pub")"
cat > "$WORK/user-data" <<EOF
#cloud-config
hostname: bitswan-e2e
# Ubuntu cloud images auto-reboot after unattended-upgrades installs updates,
# which kills the bring-up mid-run. Disable it the moment the guest boots
# (before it can fire) — bootcmd runs early on every boot.
bootcmd:
  - [ systemctl, stop, unattended-upgrades.service ]
  - [ systemctl, mask, unattended-upgrades.service, apt-daily.service, apt-daily-upgrade.service ]
write_files:
  - path: /etc/apt/apt.conf.d/99-bitswan-no-auto-reboot
    content: |
      Unattended-Upgrade::Automatic-Reboot "false";
      APT::Periodic::Update-Package-Lists "0";
      APT::Periodic::Unattended-Upgrade "0";
package_update: false
package_upgrade: false
users:
  - name: ubuntu
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys: [ "$PUB" ]
ssh_pwauth: false
EOF
echo "instance-id: bitswan-e2e" > "$WORK/meta-data"
cat > "$WORK/network-config" <<EOF
version: 2
ethernets:
  id0:
    match: { macaddress: "$VM_MAC" }
    addresses: [$VM_IP/24]
    routes:
      - to: default
        via: $VM_GW
    nameservers:
      addresses: [8.8.8.8, 1.1.1.1]
EOF
cloud-localds --network-config "$WORK/network-config" "$WORK/seed.iso" "$WORK/user-data" "$WORK/meta-data"

echo "=== boot KVM guest ($CPUS vCPU, ${MEM_MB}MB, bridged to $BRIDGE) ==="
qemu-system-x86_64 -enable-kvm -cpu host -smp "$CPUS" -m "$MEM_MB" \
  -display none -serial file:"$WORK/serial.log" -monitor none \
  -drive file="$OVERLAY",if=virtio,format=qcow2 \
  -drive file="$WORK/seed.iso",if=virtio,format=raw \
  -netdev bridge,id=n0,br="$BRIDGE" -device virtio-net-pci,netdev=n0,mac="$VM_MAC" \
  -daemonize -pidfile "$WORK/qemu.pid"

cleanup() { [ "$KEEP" = 1 ] || { kill "$(cat "$WORK/qemu.pid")" 2>/dev/null || true; }; }
trap cleanup EXIT

SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=5"
VM="ubuntu@$VM_IP"
echo "=== wait for SSH ($VM) ==="
# Poll SSH readiness — there is no event to hook for a guest finishing boot.
for i in $(seq 1 90); do $SSH "$VM" true 2>/dev/null && break; sleep 4; \
  [ "$i" = 90 ] && { echo "ERROR: guest SSH never came up"; tail -40 "$WORK/serial.log" 2>/dev/null; exit 1; }; done
mark "host: boot guest + wait for SSH"

echo "=== sync repo into guest ==="
$SSH "$VM" 'sudo mkdir -p /repo && sudo chown ubuntu /repo'
rsync -a -e "$SSH" --exclude node_modules --exclude .git --exclude 'dist/' \
  --exclude 'e2e/manual/build/' --exclude 'e2e/playwright-report/' "$REPO_ROOT/" "$VM:/repo/"
mark "host: rsync repo into guest"

echo "=== provision + run E2E in guest ==="
$SSH "$VM" 'sudo bash /repo/e2e/local-vm/provision.sh'
mark "guest: provision (apt deps)"

# Seed the guest's docker with the base images the bringup builds FROM, if a
# host-side seed tarball exists. The guest is a fresh VM whose anonymous Docker
# Hub pulls are easily rate-limited (HTTP 429) on a busy host — seeding the
# common base images (python/golang/node/alpine/debian/ubuntu) from the host
# (which can pull them) makes the build hermetic and 429-proof. Best-effort: a
# missing/partial tarball just falls back to pulling.
if [ -f "$WORK/base-images.tar" ]; then
  echo "--- seeding guest docker with base images ($WORK/base-images.tar) ---"
  scp -i "$WORK/id_ed25519" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    "$WORK/base-images.tar" "$VM:/tmp/base-images.tar" 2>/dev/null \
    && $SSH "$VM" 'sudo docker load -i /tmp/base-images.tar 2>&1 | tail -3; rm -f /tmp/base-images.tar' \
    || echo "--- base-image seed failed (continuing; build will pull) ---"
  mark "guest: seed base images"
fi

$SSH "$VM" 'bash /repo/e2e/local-vm/run-e2e.sh' || RC=$? || true
# NB: no aggregate mark here — run-e2e's time is captured in full, step by step,
# in the guest timeline (bringup builds + npm ci + playwright + walkthrough +
# manual). Marking it again would double-count it in the merged total below.

echo "=== copy the Operator's Handbook + Playwright report back ==="
mkdir -p "$REPO_ROOT/e2e/manual/build"
rsync -a -e "$SSH" "$VM:/repo/e2e/manual/build/" "$REPO_ROOT/e2e/manual/build/" 2>/dev/null || true
rsync -a -e "$SSH" "$VM:/repo/e2e/playwright-report/" "$REPO_ROOT/e2e/playwright-report/" 2>/dev/null || true
mark "host: copy artifacts back"

# Merge host + guest timelines into one slowest-first profile. The guest one
# (fine-grained build/test steps) arrives with the copy-back above.
GUEST_TL="$REPO_ROOT/e2e/manual/build/timeline.tsv"
echo
echo "############ FULL RUN PROFILE (host + guest, slowest first) ############"
{ tail -n +2 "$TL_FILE" 2>/dev/null; tail -n +2 "$GUEST_TL" 2>/dev/null; } \
  | sort -t"$(printf '\t')" -k2 -nr \
  | awk -F"$(printf '\t')" 'BEGIN{t=0} {t+=$2; printf "  %8.1fs  %s\n", $2, $4} END{printf "  --------\n  %8.1fs  TOTAL (sum of recorded steps)\n", t}'
echo "########################################################################"
echo "(timeline TSVs: host=$TL_FILE  guest=$GUEST_TL)"

[ "$KEEP" = 1 ] && echo "VM left running: $SSH $VM"
exit "${RC:-0}"
