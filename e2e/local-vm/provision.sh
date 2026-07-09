#!/usr/bin/env bash
# Provision a fresh Ubuntu guest with everything the real-stack E2E needs:
# docker, Go, Node, dnsmasq (*.localhost -> 127.0.0.1), and mkcert (trusted
# local TLS). Idempotent — safe to re-run. Used by the Vagrantfile and the raw
# QEMU runner (run-qemu.sh) alike.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "=== /etc/hosts: resolve own hostname (silences sudo warnings) ==="
grep -q "$(hostname)" /etc/hosts 2>/dev/null || echo "127.0.1.1 $(hostname)" >> /etc/hosts

echo "=== disable unattended-upgrades / auto-reboot (belt-and-braces) ==="
systemctl stop unattended-upgrades.service 2>/dev/null || true
systemctl mask unattended-upgrades.service apt-daily.service apt-daily-upgrade.service 2>/dev/null || true
apt-get -y purge unattended-upgrades 2>/dev/null || true

echo "=== apt deps ==="
apt-get update -y
apt-get install -y ca-certificates curl gnupg dnsmasq libnss3-tools sqlite3 rsync jq

echo "=== docker ==="
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
usermod -aG docker vagrant 2>/dev/null || usermod -aG docker ubuntu 2>/dev/null || true

echo "=== Go + Node ==="
if ! command -v go >/dev/null; then
  curl -fsSL https://go.dev/dl/go1.25.0.linux-amd64.tar.gz | tar -C /usr/local -xz
fi
grep -q '/usr/local/go/bin' /etc/profile.d/go.sh 2>/dev/null || \
  echo 'export PATH=$PATH:/usr/local/go/bin' > /etc/profile.d/go.sh
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "=== dnsmasq: *.localhost -> 127.0.0.1, forward the rest to the LAN gateway ==="
systemctl stop systemd-resolved 2>/dev/null || true
systemctl disable systemd-resolved 2>/dev/null || true
# Forward non-.localhost queries to the libvirt bridge gateway's resolver, NOT a
# public one. The sandbox's cloud firewall blocks direct external DNS
# (8.8.8.8:53 times out); only the host-side forwarder reachable via the guest's
# default gateway (libvirt dnsmasq, 192.168.122.1 for run-qemu / the
# Vagrant-libvirt default net) resolves. run-qemu already points resolv.conf
# there pre-provision — this used to clobber it back to 8.8.8.8 and break every
# name lookup after this point (the mkcert download died with "could not resolve
# host"). Derive the upstream from the default route so it holds on any subnet.
DNS_UPSTREAM="$(ip -4 route show default 2>/dev/null | awk '{print $3; exit}')"
[ -n "$DNS_UPSTREAM" ] || DNS_UPSTREAM=192.168.122.1
echo "    (dnsmasq upstream = $DNS_UPSTREAM)"
mkdir -p /etc/dnsmasq.d
cat > /etc/dnsmasq.d/localhost.conf <<EOF
address=/.localhost/127.0.0.1
listen-address=127.0.0.1
no-resolv
server=$DNS_UPSTREAM
EOF
rm -f /etc/resolv.conf
printf 'nameserver 127.0.0.1\nnameserver %s\n' "$DNS_UPSTREAM" > /etc/resolv.conf
systemctl restart dnsmasq || dnsmasq

echo "=== mkcert CA (trusted local TLS) ==="
if ! command -v mkcert >/dev/null; then
  curl -fsSL --retry 3 --retry-connrefused -o /usr/local/bin/mkcert "https://dl.filippo.io/mkcert/latest?for=linux/amd64"
  chmod +x /usr/local/bin/mkcert
fi
mkcert -install

echo "=== provision complete ==="
