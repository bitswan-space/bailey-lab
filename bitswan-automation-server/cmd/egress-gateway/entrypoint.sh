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
iptables -t nat -F OUTPUT
iptables -t nat -A OUTPUT -m owner --uid-owner "$PROXY_UID" -j RETURN
iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-ports 8443
iptables -t nat -A OUTPUT -p tcp --dport 80  -j REDIRECT --to-ports 8080

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

echo "egress-gateway: iptables installed (mode=${BITSWAN_FW_MODE:-monitor}); dropping to uid $PROXY_UID"
exec su-exec "$PROXY_UID:$PROXY_UID" /usr/local/bin/egress-gateway
