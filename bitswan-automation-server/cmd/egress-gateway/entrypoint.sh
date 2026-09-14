#!/bin/sh
# Egress-gateway entrypoint. Two roles, selected by $BITSWAN_FW_ROLE:
#
#   owner  — installs the egress rules in this network namespace and HOLDS it.
#            The BP worker joins this netns (network_mode: service:<owner>) with
#            NET_ADMIN dropped, so it cannot alter the rules. Critically, NO
#            proxy runs here: the namespace's DEFAULT ROUTE and its resolver
#            both point at the proxy container (a separate namespace), so every
#            non-local packet the worker sends — ANY TCP port — leaves through
#            the proxy, and there is no privileged uid in the worker's namespace
#            to impersonate. A root worker that setuid()s to anything is still
#            fully subject to these rules — the firewall is enforced OUTSIDE
#            everything the worker can reach.
#
#   proxy  — the allow-list filter (the egress-gateway binary) plus the worker's
#            DNS forwarder. Runs in its own container/namespace on the stage
#            network. Needs NET_ADMIN for the two REDIRECT rules in ITS OWN
#            namespace (funnel every routed TCP port onto the catch-all
#            listener; :53 onto the forwarder), then drops to an unprivileged
#            uid for the proxy itself.
set -e
ROLE="${BITSWAN_FW_ROLE:-proxy}"

if [ "$ROLE" = "owner" ]; then
  [ -n "$BITSWAN_FW_PROXY" ] || { echo "owner: BITSWAN_FW_PROXY unset"; exit 1; }
  # Resolve the proxy to an IP (routes and iptables need an address). `host` is
  # from bind-tools; fall back to nslookup (busybox) if absent. This lookup goes
  # to Docker's embedded DNS — the LAST thing in this namespace that does, since
  # we repoint the resolver at the proxy below.
  PROXY_IP=$(host -t A "$BITSWAN_FW_PROXY" 2>/dev/null | awk '/has address/{print $NF; exit}')
  [ -n "$PROXY_IP" ] || PROXY_IP=$(nslookup "$BITSWAN_FW_PROXY" 2>/dev/null | awk -F'[: \t]+' '/^Address/ && $0 !~ /#/ {ip=$2} END{print ip}')
  [ -n "$PROXY_IP" ] || { echo "owner: cannot resolve proxy $BITSWAN_FW_PROXY"; exit 1; }
  PROXY_IP6=$(host -t AAAA "$BITSWAN_FW_PROXY" 2>/dev/null | awk '/has IPv6 address/{print $NF; exit}')

  # The worker's own stage-network subnet (shared netns → owner's interface).
  # Used to scope the infra-peer allowance instead of all of RFC1918.
  STAGE_SUBNET=$(ip -o -f inet addr show scope global 2>/dev/null | awk '{print $4; exit}')

  # ---- routing: every non-local packet goes to the proxy ----
  # The default route is the interception point. It is not port-specific, so a
  # worker dialing smtp.gmail.com:587 or a Postgres on :5432 reaches the proxy
  # exactly like an HTTPS call does; the proxy recovers the original ip:port
  # from conntrack (SO_ORIGINAL_DST) and applies the allow-list. Traffic to the
  # stage subnet itself is a connected route and is unaffected (infra peers).
  ip route replace default via "$PROXY_IP" dev eth0

  # ---- DNS: the proxy is the worker's resolver ----
  # Only :443/:80 name their destination in-band (SNI / Host). For every other
  # port the proxy needs to know which NAME the worker resolved to the IP it is
  # dialing, so the worker's lookups must pass through the proxy's forwarder.
  # Docker's 127.0.0.11 is loopback and cannot be DNATed off-host, so we point
  # /etc/resolv.conf at the proxy instead. The worker shares THIS file (Docker
  # binds the netns owner's resolv.conf into every network_mode:service peer),
  # and it is a bind mount, so it must be rewritten in place — never renamed.
  # Docker's own header states it makes no further changes once edited.
  if grep -q '^nameserver' /etc/resolv.conf 2>/dev/null; then
    sed "s/^nameserver .*/nameserver $PROXY_IP/" /etc/resolv.conf > /tmp/resolv.conf.new
  else
    { echo "nameserver $PROXY_IP"; cat /etc/resolv.conf 2>/dev/null; } > /tmp/resolv.conf.new
  fi
  cat /tmp/resolv.conf.new > /etc/resolv.conf
  # Drop Docker's 127.0.0.11 DNAT: there is no second resolver. Anything that
  # hard-codes 127.0.0.11 now gets nothing, rather than a name lookup the proxy
  # never saw (which would surface in the feed as an anonymous IP).
  iptables -t nat -F OUTPUT

  if [ "$BITSWAN_FW_MODE" = "enforce" ]; then
    # Default-deny egress. Allow: loopback, established, the worker's own stage
    # subnet (infra peers — not all RFC1918), the proxy (which is also where DNS
    # goes now), and ALL TCP — every TCP destination outside the connected
    # subnet is reached via the default route, i.e. through the proxy, which is
    # where the allow-list is enforced. Direct UDP (other than to the proxy) is
    # dropped: no DNS to arbitrary resolvers, no tunnelling.
    iptables -F OUTPUT
    iptables -A OUTPUT -o lo -j ACCEPT
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
    iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
    [ -n "$STAGE_SUBNET" ] && iptables -A OUTPUT -d "$STAGE_SUBNET" -j ACCEPT
    iptables -A OUTPUT -d "$PROXY_IP/32" -j ACCEPT
    iptables -A OUTPUT -p tcp -j ACCEPT
    iptables -A OUTPUT -j DROP
  fi

  # ---- IPv6 egress ----
  # Previously the gateway installed IPv4 rules only, so a worker could bypass
  # the allow-list entirely over IPv6 whenever the stage bridge had IPv6 enabled
  # (fail-open). Mirror the IPv4 policy with ip6tables so v6 is filtered too.
  #
  # If the kernel has no IPv6 stack the filter table is genuinely absent (nothing
  # to filter) and we log + skip; any OTHER ip6tables failure is fatal under
  # `set -e`, so we never silently run with IPv6 unfiltered.
  if ip6tables -L OUTPUT >/dev/null 2>&1; then
    STAGE_SUBNET6=$(ip -o -f inet6 addr show scope global 2>/dev/null | awk '{print $4; exit}')
    # Route v6 through the proxy only if it actually has a v6 address. The proxy
    # is normally v4-only; when it is, v6 egress is dropped below in enforce
    # mode and clients fall back (happy-eyeballs) to the v4 path the proxy
    # filters — so the allow-list still holds and nothing legitimate breaks.
    if [ -n "$PROXY_IP6" ]; then
      ip -6 route replace default via "$PROXY_IP6" dev eth0
    fi
    if [ "$BITSWAN_FW_MODE" = "enforce" ]; then
      # Default-deny v6 egress. The resolver is IPv4 (the proxy's v4 address),
      # so there is no v6 DNS allowance to add — only loopback, established
      # return traffic, the worker's own v6 stage subnet (infra peers), and,
      # when the proxy speaks v6, the proxy and TCP routed through it.
      ip6tables -F OUTPUT
      ip6tables -A OUTPUT -o lo -j ACCEPT
      ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
      ip6tables -A OUTPUT -d ::1/128 -j ACCEPT
      [ -n "$STAGE_SUBNET6" ] && ip6tables -A OUTPUT -d "$STAGE_SUBNET6" -j ACCEPT
      if [ -n "$PROXY_IP6" ]; then
        ip6tables -A OUTPUT -d "$PROXY_IP6" -j ACCEPT
        ip6tables -A OUTPUT -p tcp -j ACCEPT
      fi
      ip6tables -A OUTPUT -j DROP
    fi
    echo "egress-gateway[owner]: IPv6 rules installed (mode=${BITSWAN_FW_MODE:-monitor}, proxy6=${PROXY_IP6:-none})"
  else
    echo "egress-gateway[owner]: no IPv6 stack (ip6tables OUTPUT unavailable); no v6 egress to filter"
  fi

  # Signal readiness (the worker gates its start on this via the healthcheck) and
  # hold the namespace open for the worker that shares it.
  touch /tmp/fw-ready
  echo "egress-gateway[owner]: rules installed (mode=${BITSWAN_FW_MODE:-monitor}, proxy=$PROXY_IP, default route + resolver → proxy); holding netns"
  exec tail -f /dev/null
fi

# ---- ROLE=proxy — the allow-list filter + the worker's DNS forwarder ----
# Never shares the worker's netns. Root only long enough to install the two
# REDIRECTs in THIS namespace, then drops to an unprivileged uid.
OWN_IP=$(ip -o -f inet addr show scope global 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1)
[ -n "$OWN_IP" ] || { echo "proxy: cannot determine own IPv4 address"; exit 1; }

# Funnel: the workers' default route delivers packets for ANY destination to
# our interface. REDIRECT rewrites them to our own address on the catch-all
# port, where the proxy reads the original ip:port back out of conntrack. Only
# packets NOT addressed to us are egress; those addressed to us are either DNS
# (redirected to the forwarder) or infrastructure noise (left alone).
iptables -t nat -A PREROUTING -p tcp ! -d "$OWN_IP/32" -j REDIRECT --to-ports 18000
iptables -t nat -A PREROUTING -p udp -d "$OWN_IP/32" --dport 53 -j REDIRECT --to-ports 18053
iptables -t nat -A PREROUTING -p tcp -d "$OWN_IP/32" --dport 53 -j REDIRECT --to-ports 18053
if [ "$BITSWAN_FW_MODE" = "enforce" ]; then
  # Nothing is ever FORWARDED through the proxy in enforce mode: TCP is
  # intercepted above and the owner drops other protocols at the source. This
  # is belt-and-braces against a worker namespace with a broken rule set.
  iptables -P FORWARD DROP
else
  # Monitor mode is observe-only and must not break anything that worked
  # without a firewall — UDP (NTP, QUIC, syslog) and ICMP included. Those are
  # not TCP, so REDIRECT leaves them alone; forward them out as ourselves
  # (net.ipv4.ip_forward is enabled on this container by the compose entry).
  iptables -t nat -A POSTROUTING ! -s "$OWN_IP/32" -j MASQUERADE
fi
if ip6tables -L OUTPUT >/dev/null 2>&1; then
  OWN_IP6=$(ip -o -f inet6 addr show scope global 2>/dev/null | awk '{print $4; exit}' | cut -d/ -f1)
  if [ -n "$OWN_IP6" ]; then
    ip6tables -t nat -A PREROUTING -p tcp ! -d "$OWN_IP6/128" -j REDIRECT --to-ports 18000
    if [ "$BITSWAN_FW_MODE" = "enforce" ]; then
      ip6tables -P FORWARD DROP
    else
      ip6tables -t nat -A POSTROUTING ! -s "$OWN_IP6/128" -j MASQUERADE
    fi
  fi
fi

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

echo "egress-gateway[proxy]: starting allow-list filter on :18000 (all TCP) + :18443/:18080, DNS forwarder on :18053 (mode=${BITSWAN_FW_MODE:-monitor}, ip=$OWN_IP)"
exec su-exec "$PROXY_UID:$PROXY_UID" /usr/local/bin/egress-gateway
