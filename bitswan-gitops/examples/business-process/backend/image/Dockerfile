# Go backend base (air hot-reload; the BP source is bind-mounted at /app in
# live-dev). GOPROXY is a build ARG (default: the public proxy, so a build with
# no proxy behaves as before). When the automation server runs a shared
# read-through Go module proxy, the driver passes it so `go install air`/`go mod
# download` fetch from the warm local cache. Applied PER-RUN (not ENV) so the
# runtime image keeps the public default — the proxy is reachable only on the
# build network, and runtime `air` recompiles against the public proxy.
# Integrity stays client-side (GOSUMDB), so a bad proxy cannot swap modules.
FROM golang:1.25-alpine
ARG GOPROXY=https://proxy.golang.org,direct

RUN GOPROXY="${GOPROXY}" go install github.com/air-verse/air@v1.61.7

ENV GOFLAGS=-mod=mod

WORKDIR /deps
COPY go.mod ./
RUN GOPROXY="${GOPROXY}" go mod download

WORKDIR /app

COPY entrypoint.sh /entrypoint.sh
COPY air.toml /etc/air.toml
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
