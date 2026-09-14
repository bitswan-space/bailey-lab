# Bitswan per-BP egress firewall gateway image.
# Build context = the bitswan-automation-server repo root:
#   docker build -f cmd/egress-gateway/Dockerfile -t bitswan/egress-gateway:dev .
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /egress-gateway ./cmd/egress-gateway

FROM alpine:3.20
# iptables: the owner installs the egress rules in the worker's netns and the
# proxy its own REDIRECT funnel. bind-tools (`host`) + iproute2 (`ip`): the owner
# resolves the proxy IP for the default route / resolver and reads its own stage
# subnet. su-exec: drop to the unprivileged proxy uid.
RUN apk add --no-cache iptables su-exec bind-tools iproute2 ca-certificates \
 && adduser -D -u 8765 bswgw
COPY --from=build /egress-gateway /usr/local/bin/egress-gateway
COPY cmd/egress-gateway/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Needs NET_ADMIN to install its iptables rules (the BP containers that share its
# netns do NOT — that's the point).
#
# Cheap liveness probe on the dedicated health port (:18077). The proxy binds it
# only after the filter ports (:18000 catch-all, :18443/:18080) and the DNS
# forwarder (:18053), so a TCP-open check is a faithful "gateway is up" signal —
# and probing :18077 (not the filter ports) avoids logging a bogus no-SNI attempt
# on every healthcheck. The netns owner installs its rules only once the proxy is
# healthy, and workers gate their start on the owner, so nobody races a half-up
# gateway. (busybox `nc -z` returns 0 only when up.)
HEALTHCHECK --interval=3s --timeout=3s --retries=10 --start-period=2s \
  CMD nc -z 127.0.0.1 18077
ENTRYPOINT ["/entrypoint.sh"]
