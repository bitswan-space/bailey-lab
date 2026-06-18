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
ENTRYPOINT ["/entrypoint.sh"]
