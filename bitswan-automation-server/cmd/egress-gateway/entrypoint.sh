#!/bin/sh
# Egress-gateway entrypoint. Runs as root to install the netns-wide iptables
# interception, then drops to the unprivileged proxy uid. BP containers share
# this netns (network_mode: service:<gateway>) but have NET_ADMIN dropped, so
# they cannot alter these rules — and the proxy's own outbound (uid 8765) is the
# only traffic exempt from redirection.
set -e
PROXY_UID=8765

# nat OUTPUT: exempt the proxy's own dials, redirect everyone else's :443/:80
# to the local SNI/Host filter. Applies in BOTH modes (monitor needs it to log).
#
# Flushing OUTPUT drops the jump Docker installs to its embedded-DNS DNAT chain
# (`-d 127.0.0.11/32 -j DOCKER_OUTPUT`), which would silently break name
# resolution for EVERY container sharing this netns (they'd resolve nothing —
# not infra peers, not the internet). The DOCKER_OUTPUT chain itself survives the
# flush (only the OUTPUT-chain jump to it is lost), so re-add that jump FIRST, so
# DNS to 127.0.0.11:53 is DNAT'd to the resolver before our :443/:80 redirects.
iptables -t nat -F OUTPUT
if iptables -t nat -L DOCKER_OUTPUT >/dev/null 2>&1; then
  iptables -t nat -A OUTPUT -d 127.0.0.11/32 -j DOCKER_OUTPUT
fi
iptables -t nat -A OUTPUT -m owner --uid-owner "$PROXY_UID" -j RETURN
iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-ports 18443
iptables -t nat -A OUTPUT -p tcp --dport 80  -j REDIRECT --to-ports 18080

if [ "$BITSWAN_FW_MODE" = "enforce" ]; then
  # Default-deny egress. Allow: loopback, established, the proxy's dials, DNS,
  # RFC1918 (infra services on the docker networks), and :80/:443 (which are
  # redirected to the proxy, where the allow-list is actually enforced).
  iptables -F OUTPUT
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
  iptables -A OUTPUT -m owner --uid-owner "$PROXY_UID" -j ACCEPT
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
  iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
  iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
  iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 80  -j ACCEPT
  iptables -A OUTPUT -j DROP
fi

# The attempts feed lives on a bind-mounted volume (/firewall) created by the
# gitops container as root. The proxy runs unprivileged (uid $PROXY_UID), so it
# could not create/append its JSONL there — the writes would fail silently and
# "Needs review" would stay empty. Grant the proxy uid ownership of the mount
# while we are still root, before dropping privileges. The attempts path is the
# directory containing the configured BITSWAN_FW_ATTEMPTS file (default /firewall).
if [ -n "$BITSWAN_FW_ATTEMPTS" ]; then
  ATTEMPTS_DIR=$(dirname "$BITSWAN_FW_ATTEMPTS")
else
  ATTEMPTS_DIR=/firewall
fi
if [ -d "$ATTEMPTS_DIR" ]; then
  # Only chown the mount root, not recursively — keeps it cheap and avoids
  # touching other BPs' files that may already be owned by the proxy uid.
  chown "$PROXY_UID:$PROXY_UID" "$ATTEMPTS_DIR" || \
    echo "egress-gateway: WARNING could not chown $ATTEMPTS_DIR (attempts log may not be writable)"
fi

echo "egress-gateway: iptables installed (mode=${BITSWAN_FW_MODE:-monitor}); dropping to uid $PROXY_UID"
exec su-exec "$PROXY_UID:$PROXY_UID" /usr/local/bin/egress-gateway
