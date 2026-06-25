#!/bin/sh
# Egress-gateway entrypoint. Two roles, selected by $BITSWAN_FW_ROLE:
#
#   owner  — installs the egress rules in this network namespace and HOLDS it.
#            The BP worker joins this netns (network_mode: service:<owner>) with
#            NET_ADMIN dropped, so it cannot alter the rules. Critically, NO
#            proxy runs here: the worker's :443/:80 is DNAT'd to the proxy
#            container (a separate namespace), so there is no privileged uid in
#            the worker's namespace to impersonate. A root worker that setuid()s
#            to anything is still fully subject to these rules — the firewall is
#            enforced OUTSIDE everything the worker can reach.
#
#   proxy  — the SNI/Host allow-list filter (the egress-gateway binary). Runs in
#            its own container/namespace on the stage network, unprivileged.
set -e
ROLE="${BITSWAN_FW_ROLE:-proxy}"

if [ "$ROLE" = "owner" ]; then
  [ -n "$BITSWAN_FW_PROXY" ] || { echo "owner: BITSWAN_FW_PROXY unset"; exit 1; }
  # Resolve the proxy to an IP (iptables DNAT needs an address). `host` is from
  # bind-tools; fall back to nslookup (busybox) if absent.
  PROXY_IP=$(host -t A "$BITSWAN_FW_PROXY" 2>/dev/null | awk '/has address/{print $NF; exit}')
  [ -n "$PROXY_IP" ] || PROXY_IP=$(nslookup "$BITSWAN_FW_PROXY" 2>/dev/null | awk -F'[: \t]+' '/^Address/ && $0 !~ /#/ {ip=$2} END{print ip}')
  [ -n "$PROXY_IP" ] || { echo "owner: cannot resolve proxy $BITSWAN_FW_PROXY"; exit 1; }

  # The worker's own stage-network subnet (shared netns → owner's interface).
  # Used to scope the infra-peer allowance instead of all of RFC1918.
  STAGE_SUBNET=$(ip -o -f inet addr show scope global 2>/dev/null | awk '{print $4; exit}')

  # nat OUTPUT: keep Docker's embedded-DNS DNAT (flushing OUTPUT drops the jump
  # to DOCKER_OUTPUT), then DNAT all :443/:80 to the external proxy. NO uid
  # exemption — nothing in this netns is exempt.
  iptables -t nat -F OUTPUT
  if iptables -t nat -L DOCKER_OUTPUT >/dev/null 2>&1; then
    iptables -t nat -A OUTPUT -d 127.0.0.11/32 -j DOCKER_OUTPUT
  fi
  iptables -t nat -A OUTPUT -p tcp --dport 443 -j DNAT --to-destination "$PROXY_IP:18443"
  iptables -t nat -A OUTPUT -p tcp --dport 80  -j DNAT --to-destination "$PROXY_IP:18080"

  if [ "$BITSWAN_FW_MODE" = "enforce" ]; then
    # Default-deny egress. Allow: loopback, established, DNS to Docker's embedded
    # resolver ONLY (direct :53 to arbitrary resolvers is dropped — no DNS
    # tunnelling), the worker's own stage subnet (infra peers — not all RFC1918),
    # the proxy, and the :80/:443 the proxy enforces.
    iptables -F OUTPUT
    iptables -A OUTPUT -o lo -j ACCEPT
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
    iptables -A OUTPUT -d 127.0.0.11/32 -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -d 127.0.0.11/32 -p tcp --dport 53 -j ACCEPT
    iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
    [ -n "$STAGE_SUBNET" ] && iptables -A OUTPUT -d "$STAGE_SUBNET" -j ACCEPT
    iptables -A OUTPUT -d "$PROXY_IP/32" -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 80  -j ACCEPT
    iptables -A OUTPUT -j DROP
  fi

  # Signal readiness (the worker gates its start on this via the healthcheck) and
  # hold the namespace open for the worker that shares it.
  touch /tmp/fw-ready
  echo "egress-gateway[owner]: rules installed (mode=${BITSWAN_FW_MODE:-monitor}, proxy=$PROXY_IP); holding netns"
  exec tail -f /dev/null
fi

# ROLE=proxy — the SNI/Host filter. No NET_ADMIN; never shares the worker's netns.
PROXY_UID=8765
if [ -n "$BITSWAN_FW_ATTEMPTS" ]; then
  ATTEMPTS_DIR=$(dirname "$BITSWAN_FW_ATTEMPTS")
else
  ATTEMPTS_DIR=/firewall
fi
if [ -d "$ATTEMPTS_DIR" ]; then
  chown "$PROXY_UID:$PROXY_UID" "$ATTEMPTS_DIR" 2>/dev/null || \
    echo "egress-gateway[proxy]: WARNING could not chown $ATTEMPTS_DIR (attempts log may not be writable)"
fi

echo "egress-gateway[proxy]: starting SNI/Host filter on :18443/:18080 (mode=${BITSWAN_FW_MODE:-monitor})"
exec su-exec "$PROXY_UID:$PROXY_UID" /usr/local/bin/egress-gateway
