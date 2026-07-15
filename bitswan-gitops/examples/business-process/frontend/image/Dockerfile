# Frontend image. The Go shim (this image/shim) is built and baked in; it
# fronts vite (the React app, bind-mounted at /app and hot-reloaded in
# live-dev) on :8080 and proxies /api to the private backend worker.
#
# GOPROXY / NPM_CONFIG_REGISTRY are build ARGs (default: the public endpoints,
# so a build with no proxy behaves exactly as before). When the automation
# server runs a shared read-through package proxy, the driver passes these so
# npm install / go build fetch from the warm local cache. They're applied
# PER-RUN (not ENV) so nothing persists into the runtime image — the proxy is
# reachable only on the build network, and runtime `air`/npm must use the public
# default. Integrity stays client-side (GOSUMDB / npm lockfile), so a bad proxy
# cannot swap module content.
FROM golang:1.25-alpine AS shim
ARG GOPROXY=https://proxy.golang.org,direct
WORKDIR /src
COPY shim/go.mod ./
COPY shim/main.go ./
RUN GOPROXY="${GOPROXY}" CGO_ENABLED=0 go build -o /shim .

FROM node:24-alpine
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
RUN NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY}" npm install -g serve
# Deps installed once at build time into /deps; the bind-mounted source tree
# carries committed symlinks (package.json, node_modules) that resolve here.
WORKDIR /deps
COPY package.json ./
RUN NPM_CONFIG_REGISTRY="${NPM_CONFIG_REGISTRY}" npm install
COPY --from=shim /shim /usr/local/bin/shim
WORKDIR /app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
