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
RUN apk add --no-cache iptables su-exec ca-certificates \
 && adduser -D -u 8765 bswgw
COPY --from=build /egress-gateway /usr/local/bin/egress-gateway
COPY cmd/egress-gateway/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
# Needs NET_ADMIN to install its iptables rules (the BP containers that share its
# netns do NOT — that's the point).
#
# Cheap liveness probe on the dedicated health port (:18077). The proxy binds it
# in the same startup as :18443/:18080, so a TCP-open check is a faithful "gateway
# is up" signal — and probing :18077 (not the filter ports) avoids logging a bogus
# no-SNI attempt on every healthcheck. The filter/health ports are deliberately
# high/uncommon so they never collide with an app's own listen port in the shared
# netns. Workers that share this netns (network_mode: service:<gw>) gate their
# start on this via compose `depends_on: { <gw>: { condition: service_healthy } }`,
# so they never race a half-up gateway. (busybox `nc -z` returns 0 only when up.)
HEALTHCHECK --interval=3s --timeout=3s --retries=10 --start-period=2s \
  CMD nc -z 127.0.0.1 18077
ENTRYPOINT ["/entrypoint.sh"]
