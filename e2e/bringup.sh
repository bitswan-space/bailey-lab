#!/usr/bin/env bash
# Stand up the REAL Bailey platform with its protected gate, so a browser can go
# through the actual onboarding (OIDC sign-in → claim the server → device trust)
# and then create a workspace through the Server Console UI — exactly as an
# operator would. Everything is real docker: the daemon, traefik, the protected
# proxy, gitops, the dashboard. The ONLY stand-in is the identity provider: a
# disposable Keycloak with a seeded realm (the Meridian Foods cast).
#
# Topology (faithful to production):
#   platform-traefik → bitswan-protected-proxy (oauth2-proxy + Keycloak)
#                    → :9080 Bailey gate (device trust) → daemon / workspace apps
#
# Prereqs the runner/VM provides: docker + compose, dnsmasq (*.localhost→127.0.0.1),
# mkcert CA installed, sudo for the daemon init.
#
# Usage: e2e/bringup.sh   (from the repo root). Writes e2e/.env for Playwright.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Step profiler — continues the timeline begun in run-e2e.sh (shared state file),
# so each build sub-step below shows up in the slowest-first profile. `mark` is a
# no-op-safe if sourced standalone. Fall back to a stub if the helper is absent.
if [ -f "$REPO_ROOT/e2e/local-vm/timeline.sh" ]; then
  source "$REPO_ROOT/e2e/local-vm/timeline.sh"
else
  mark() { :; }
fi

DOMAIN="bs-e2e.localhost"
KC_HOST="keycloak.${DOMAIN}"
KC_PORT="8088"
BAILEY_URL="https://bailey.${DOMAIN}"
ONBOARD_URL="https://bailey-onboard.${DOMAIN}"
DAEMON_CTR="bitswan-automation-server-daemon"

# Dogfood the -dev images built by build-dev-images.sh (see [1/7] below) and
# pin the daemon to them via the BITSWAN_*_IMAGE overrides, so workspaces the
# Server Console UI creates run THIS checkout's services.
GITOPS_IMAGE="bitswan/gitops-dev:latest"
DASHBOARD_IMAGE="bitswan/workspace-dashboard-dev:latest"
CODING_AGENT_IMAGE="bitswan/coding-agent-dev:latest"
# The per-workspace infra-driver sidecar (the only container with docker.sock).
INFRA_DRIVER_IMAGE="bitswan/infra-driver-dev:latest"
# The per-BP egress firewall gateway. gitops references it by BITSWAN_EGRESS_GATEWAY_IMAGE
# so a deployed firewall can stand up the SNI/Host allow-list proxy that observes
# egress for the dashboard's "needs review" feed. Without this image the gateway
# service can't start and no egress is ever observed.
EGRESS_GATEWAY_IMAGE="bitswan/egress-gateway-dev:latest"

# The SIEM target: a real, lightweight OpenTelemetry collector with an OTLP
# receiver (gRPC :4317 + HTTP :4318) and a debug exporter. Bailey's SIEM
# forwarding points here so the connectivity test succeeds and audit events
# actually flow. NOTE: this image is NOT built locally — it is pulled from the
# registry, so it must be added to the base-image seed tarball
# (/tmp/bitswan-e2e-vm/base-images.tar) or the VM may 429 pulling it.
OTEL_COLLECTOR_IMAGE="otel/opentelemetry-collector:0.115.1"
OTEL_CTR="bitswan-e2e-otel"

echo "=== [1/7] Build the Server Console SPA + the bitswan CLI + component images ==="
# The daemon embeds the Server Console SPA via go:embed from
# internal/daemon/serverconsole_dist (not committed). Build it into the embed
# dir BEFORE compiling the CLI, or the gate serves an empty console (a directory
# listing) instead of the real onboarding/console UI.
make -C "$REPO_ROOT/bitswan-automation-server" console
mark "[1/7] server-console: make console"
( cd bitswan-automation-server && go build -o bitswan ./main.go )
mark "[1/7] bitswan CLI: go build"
BITSWAN="$REPO_ROOT/bitswan-automation-server/bitswan"
# Build every workspace-service image (gitops, dashboard, coding-agent,
# egress-gateway, infra-driver) as bitswan/<svc>-dev:latest in one parallel pass
# — the same script developers run locally. The daemon is pinned to these -dev
# tags below, so the Server Console UI creates workspaces on this checkout's code.
"$REPO_ROOT/build-dev-images.sh"
mark "[1/7] build-dev-images.sh: gitops/dashboard/coding-agent/egress/infra-driver"

# The daemon container itself runs this image (debian + docker CLI + git +
# git-http-backend) with the bitswan binary mounted at runtime, so build the tag
# here or `automation-server-daemon init` can't start it on a hub-less VM.
docker build -t bitswan/automation-server-runtime:latest -f "$REPO_ROOT/bitswan-automation-server/Dockerfile" "$REPO_ROOT/bitswan-automation-server"
mark "[1/7] docker build: automation-server-runtime image"

echo "=== [2/7] Daemon + traefik ingress ==="
# Shared read-through PACKAGE PROXIES for per-BP image builds (a Go module proxy
# + an npm registry proxy). Per-BP builds otherwise re-download npm/Go deps from
# the internet on every create-bp (~50s of the cold build); routing them through
# a warm local proxy makes them fast. Security: both are PURE READ-THROUGH — they
# only serve verified upstream artifacts and accept no client writes/publishes,
# so they can't be a cross-workspace channel. They live on a DEDICATED
# bitswan-build-proxy network (builds join only this net, never bitswan_network),
# so a build can reach the proxies + the internet but NOT other workspaces.
# Client-side integrity (GOSUMDB / npm lockfile) stays on. All opt-in: the daemon
# passes the wiring to each workspace's driver via env; without it, builds go
# direct.
BUILD_PROXY_NET="bitswan-build-proxy"
docker network inspect "$BUILD_PROXY_NET" >/dev/null 2>&1 || docker network create "$BUILD_PROXY_NET" >/dev/null
docker rm -f bitswan-goproxy bitswan-npmproxy >/dev/null 2>&1 || true
# Go module proxy (Athens): read-through (download-mode=sync), disk-cached.
# ATHENS_STORAGE_TYPE=disk REQUIRES an existing storage root — the image default
# is a literal `/path/on/disk` placeholder that does not exist, so Athens
# crash-loops without ATHENS_DISK_STORAGE_ROOT + a volume to back it.
docker volume create bitswan-athens-storage >/dev/null
docker run -d --name bitswan-goproxy --network "$BUILD_PROXY_NET" --restart unless-stopped \
  -e ATHENS_DOWNLOAD_MODE=sync -e ATHENS_STORAGE_TYPE=disk \
  -e ATHENS_DISK_STORAGE_ROOT=/var/lib/athens \
  -v bitswan-athens-storage:/var/lib/athens \
  gomods/athens:latest >/dev/null
# npm registry proxy (Verdaccio): pure read-through, publish disabled (see config).
docker run -d --name bitswan-npmproxy --network "$BUILD_PROXY_NET" --restart unless-stopped \
  -v "$REPO_ROOT/e2e/build-proxy/verdaccio.yaml:/verdaccio/conf/config.yaml:ro" \
  verdaccio/verdaccio:6 >/dev/null
# NOTE the `|` (not `,`): with a comma, Go only falls through to `direct` on an
# HTTP 404/410 — a DOWN/unreachable Athens (connection refused, 5xx) would fail
# the build outright. The pipe makes Go fall through to `direct` on ANY error,
# so a proxy problem degrades to a direct (slower) build instead of a broken one.
BITSWAN_GOPROXY_URL="http://bitswan-goproxy:3000|direct"
BITSWAN_NPM_REGISTRY_URL="http://bitswan-npmproxy:4873"
mark "[1b/7] read-through build package proxies (Athens + Verdaccio)"

# Pin the daemon to THIS checkout's images so workspaces it creates via the
# Server Console UI run the branch's gitops/dashboard/coding-agent (with the
# features the manual documents) instead of Docker Hub 'latest'. sudo strips the
# environment, so set it explicitly on the command via `env`.
sudo env \
  BITSWAN_GITOPS_IMAGE="$GITOPS_IMAGE" \
  BITSWAN_DASHBOARD_IMAGE="$DASHBOARD_IMAGE" \
  BITSWAN_CODING_AGENT_IMAGE="$CODING_AGENT_IMAGE" \
  BITSWAN_INFRA_DRIVER_IMAGE="$INFRA_DRIVER_IMAGE" \
  BITSWAN_EGRESS_GATEWAY_IMAGE="$EGRESS_GATEWAY_IMAGE" \
  BITSWAN_BUILD_NETWORK="$BUILD_PROXY_NET" \
  BITSWAN_GOPROXY="$BITSWAN_GOPROXY_URL" \
  BITSWAN_NPM_REGISTRY="$BITSWAN_NPM_REGISTRY_URL" \
  "$BITSWAN" automation-server-daemon init
sleep 5
"$BITSWAN" automation-server-daemon status
# `ingress init` makes the daemon pull + start traefik; on a cold host that pull
# can exceed the daemon client's request deadline. Pre-pull, then retry.
docker pull traefik:v3.6 >/dev/null 2>&1 || true
for i in 1 2 3 4 5; do
  "$BITSWAN" ingress init -v && break
  echo "ingress init attempt $i timed out; traefik image now warming, retrying..."; sleep 12
done
# No pipe here on purpose: `docker ps | grep -q traefik` under pipefail is a
# false-negative race — grep -q exits on the first match (traefik is the newest
# container, so the first row) while docker ps is still writing its remaining
# rows in small tabwriter chunks, docker dies of SIGPIPE (141) and pipefail
# fails the pipeline even though the match succeeded.
[ -n "$(docker ps -q -f name='^traefik$')" ] || { echo "ERROR: traefik not running"; exit 1; }

mark "[2/7] daemon + traefik ingress"

# Prewarm every image the INTERACTIVE workspace-create + first-deploy would
# otherwise pull at click-time: the infra services a BP enables (postgres,
# garage + its rclone toolbox, couchdb) and node:24-alpine (the app-image base the driver
# bakes the frontend/backend onto). Runs in the BACKGROUND so it overlaps the
# Keycloak/otel bring-up below and adds ~no serial setup time; we `wait` on it
# before handing off to the walkthrough. Moving these pulls into the
# non-interactive setup keeps the first deploy from stalling a user on a
# registry pull. Best-effort — a miss just falls back to a click-time pull.
( for img in postgres:16 dxflrs/garage:v2.3.0 rclone/rclone:1.68 couchdb:3.3 node:24-alpine golang:1.25-alpine; do
    docker pull "$img" >/dev/null 2>&1 || true
  done
  # Prebuild the BP-template frontend + backend base images so their EXPENSIVE
  # layers are warm in the local docker cache before the first `create-bp`. The
  # driver bakes each BP's live-dev image from these same Dockerfiles/contexts
  # (frontend: `npm install` into /deps; backend: `go install air` + `go mod
  # download`) — building them here once means create-bp's build is a layer-cache
  # hit instead of a cold ~60-90s install. Throwaway tags; we only want the
  # cached layers. Best-effort — a miss just falls back to a cold build.
  # Build through the read-through proxies with EXACTLY the same --network +
  # --build-arg the driver passes at create-bp time. This matters for two
  # reasons: (1) it populates the Athens / Verdaccio caches from upstream; (2)
  # BuildKit folds the GOPROXY / NPM_CONFIG_REGISTRY build-args into the cache
  # key of the `RUN go mod download` / `RUN npm install` layers, so the per-BP
  # build only gets a LAYER-cache hit (skipping the download entirely) when its
  # args match this prewarm's byte-for-byte. We deliberately do NOT fall back to
  # an argless build on failure: that would bake the warm layers under a
  # different cache key and guarantee a miss on the real build. `|direct` in
  # GOPROXY already makes this robust to a down proxy, so the proxy args are
  # always the right ones to prewarm with.
  fe="$REPO_ROOT/bitswan-gitops/examples/business-process/frontend/image"
  be="$REPO_ROOT/bitswan-gitops/examples/business-process/backend/image"
  # DOCKER_BUILDKIT=0 (legacy builder) is REQUIRED here, for two reasons:
  #   1. BuildKit rejects a custom --network ("network mode X not supported by
  #      buildkit"), so a BuildKit prewarm would just fail — and the driver's
  #      per-BP build uses --network "$BUILD_PROXY_NET", so we must match it.
  #   2. BuildKit and the legacy builder keep SEPARATE, non-shared layer caches.
  #      The driver builds with the legacy builder (its runtime image has no
  #      buildx), so this prewarm must ALSO be legacy or the warm layers land in
  #      a cache the driver never consults — the create-bp build would recompile
  #      `go install air` (~40s) every time despite a "successful" prewarm.
  pxy=(--network "$BUILD_PROXY_NET" --build-arg "GOPROXY=$BITSWAN_GOPROXY_URL" --build-arg "NPM_CONFIG_REGISTRY=$BITSWAN_NPM_REGISTRY_URL")
  [ -f "$fe/Dockerfile" ] && { DOCKER_BUILDKIT=0 docker build "${pxy[@]}" -t bitswan/bp-frontend-template:warm "$fe" >/dev/null 2>&1 || echo "  prewarm frontend build failed (create-bp will build cold)"; }
  [ -f "$be/Dockerfile" ] && { DOCKER_BUILDKIT=0 docker build "${pxy[@]}" -t bitswan/bp-backend-template:warm "$be" >/dev/null 2>&1 || echo "  prewarm backend build failed (create-bp will build cold)"; }
) &
PREWARM_PID=$!

echo "=== [3/7] Disposable Keycloak (seeded realm: the Meridian Foods cast) on :${KC_PORT} ==="
# Published on the host port so the BROWSER (dnsmasq→127.0.0.1) and the
# oauth2-proxy CONTAINER (extra_hosts→host-gateway) reach the SAME issuer URL,
# so the iss claim matches on both legs. http only (sslRequired=none).
docker rm -f bitswan-e2e-keycloak >/dev/null 2>&1 || true
docker run -d --name bitswan-e2e-keycloak --network bitswan_network \
  -p "${KC_PORT}:${KC_PORT}" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -e KC_HTTP_ENABLED=true -e KC_HTTP_PORT="${KC_PORT}" \
  -e KC_HOSTNAME="http://${KC_HOST}:${KC_PORT}" -e KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true \
  -e KC_PROXY_HEADERS=xforwarded \
  -v "$REPO_ROOT/e2e/keycloak/realm-export.json:/opt/keycloak/data/import/realm-export.json:ro" \
  quay.io/keycloak/keycloak:26.0 \
  start-dev --import-realm --http-port "${KC_PORT}"

echo "Waiting for Keycloak realm to be ready..."
for i in $(seq 1 60); do
  curl -fsS "http://localhost:${KC_PORT}/realms/bitswan/.well-known/openid-configuration" >/dev/null 2>&1 && { echo "Keycloak ready"; break; }
  sleep 3
  [ "$i" = 60 ] && { echo "ERROR: Keycloak did not become ready"; docker logs --tail 50 bitswan-e2e-keycloak; exit 1; }
done

mark "[3/7] keycloak (seeded realm)"
echo "=== [3b/7] Real OTLP ingestor (otel-collector) — the SIEM forwarding target ==="
# A genuine OpenTelemetry collector on the shared bitswan_network so the daemon
# reaches it by container name (bitswan-e2e-otel) over OTLP/HTTP :4318 (the
# POST /v1/logs path Bailey uses) and OTLP/gRPC :4317. A debug exporter logs
# every received record to the collector's stdout, so forwarding SUCCEEDS (the
# SIEM card shows Connected) instead of the connection error you get pointing
# at a dead endpoint. Surfaced to the walkthrough via E2E_OTLP_* in e2e/.env.
docker rm -f "$OTEL_CTR" >/dev/null 2>&1 || true
docker pull "$OTEL_COLLECTOR_IMAGE" >/dev/null 2>&1 || true
docker run -d --name "$OTEL_CTR" --network bitswan_network \
  -v "$REPO_ROOT/e2e/otel/collector-config.yaml:/etc/otelcol/config.yaml:ro" \
  "$OTEL_COLLECTOR_IMAGE" --config /etc/otelcol/config.yaml
# SIGPIPE-safe readiness poll — no `docker ps | grep` under pipefail (that's the
# false-negative the traefik check above was fixed for; same trap here).
for i in $(seq 1 15); do if [ -n "$(docker ps -q -f name="^${OTEL_CTR}$")" ]; then break; fi; sleep 2; done
[ -n "$(docker ps -q -f name="^${OTEL_CTR}$")" ] || { echo "ERROR: otel-collector not running"; docker logs --tail 50 "$OTEL_CTR"; exit 1; }

mark "[3b/7] otel-collector (SIEM target)"
echo "=== [4/7] bitswan-protected-proxy (oauth2-proxy) in front of the gate ==="
# This is the production chain's first hop. It runs the OIDC handshake against
# Keycloak and forwards the verified identity to the :9080 gate as
# X-Forwarded-Email / X-Forwarded-Groups. cookie domain .${DOMAIN} so the session
# is shared across bailey. / bailey--inner. / bailey-onboard.
docker rm -f bitswan-protected-proxy >/dev/null 2>&1 || true
docker run -d --name bitswan-protected-proxy --network bitswan_network \
  --add-host "${KC_HOST}:host-gateway" \
  -e OAUTH2_PROXY_PROVIDER=oidc \
  -e OAUTH2_PROXY_OIDC_ISSUER_URL="http://${KC_HOST}:${KC_PORT}/realms/bitswan" \
  -e OAUTH2_PROXY_CLIENT_ID=bailey \
  -e OAUTH2_PROXY_CLIENT_SECRET=bailey-e2e-secret \
  -e OAUTH2_PROXY_COOKIE_SECRET=0123456789abcdef0123456789abcdef \
  -e OAUTH2_PROXY_EMAIL_DOMAINS='*' \
  -e OAUTH2_PROXY_SCOPE="openid email profile" \
  -e OAUTH2_PROXY_UPSTREAMS="http://${DAEMON_CTR}:9080" \
  -e OAUTH2_PROXY_HTTP_ADDRESS=0.0.0.0:80 \
  -e OAUTH2_PROXY_REVERSE_PROXY=true \
  -e OAUTH2_PROXY_PASS_HOST_HEADER=true \
  -e OAUTH2_PROXY_PASS_USER_HEADERS=true \
  -e OAUTH2_PROXY_SET_XAUTHREQUEST=true \
  -e OAUTH2_PROXY_PASS_ACCESS_TOKEN=true \
  -e OAUTH2_PROXY_SKIP_PROVIDER_BUTTON=true \
  -e OAUTH2_PROXY_REDIRECT_URL="${BAILEY_URL}/oauth2/callback" \
  -e OAUTH2_PROXY_COOKIE_DOMAINS=".${DOMAIN}" \
  -e OAUTH2_PROXY_WHITELIST_DOMAINS=".${DOMAIN},${KC_HOST}:${KC_PORT}" \
  -e OAUTH2_PROXY_COOKIE_SECURE=true \
  -e OAUTH2_PROXY_COOKIE_SAMESITE=none \
  -e OAUTH2_PROXY_COOKIE_CSRF_PER_REQUEST=true \
  -e OAUTH2_PROXY_COOKIE_CSRF_EXPIRE=1h \
  -e OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true \
  quay.io/oauth2-proxy/oauth2-proxy:v7.7.1
# SIGPIPE-safe readiness poll (see the traefik/otel checks above).
for i in $(seq 1 15); do if [ -n "$(docker ps -q -f name='^bitswan-protected-proxy$')" ]; then break; fi; sleep 2; done
[ -n "$(docker ps -q -f name='^bitswan-protected-proxy$')" ] || { echo "ERROR: protected proxy not running"; docker logs --tail 50 bitswan-protected-proxy; exit 1; }

mark "[4/7] protected-proxy (oauth2-proxy)"
echo "=== [5/7] Point Bailey at this domain + register the gate routes ==="
# protected_domain drives ProtectedHostnameDomain(); on (re)start the daemon's
# setupBaileyRoutes registers bailey. / bailey--inner. / bailey-onboard. →
# bitswan-protected-proxy:80, but ONLY when the proxy is already running. So we
# set the domain and restart the daemon now that the proxy is up.
docker exec "$DAEMON_CTR" sh -c \
  'CFG=/root/.config/bitswan/automation_server_config.toml; touch "$CFG"; \
   grep -q "^protected_domain" "$CFG" || { printf "protected_domain = \"bs-e2e.localhost\"\n%s" "$(cat "$CFG")" > "$CFG.new" && mv "$CFG.new" "$CFG"; }'
docker restart "$DAEMON_CTR" >/dev/null
sleep 8

mark "[5/7] point Bailey at domain + restart"
echo "=== [6/7] Wait for the onboarding host to answer through the chain ==="
for i in $(seq 1 60); do
  code="$(curl -sk -o /dev/null -w '%{http_code}' "${ONBOARD_URL}/" || true)"
  # 302→Keycloak (unauthenticated) or 200 both mean the chain is wired.
  case "$code" in 200|302|401|403) echo "onboarding reachable (HTTP $code)"; break;; esac
  sleep 3
  [ "$i" = 60 ] && { echo "ERROR: onboarding host not reachable"; docker ps; docker logs --tail 40 bitswan-protected-proxy; exit 1; }
done

mark "[6/7] wait onboarding chain ready"
# Ensure the background image prewarm finished before the walkthrough starts, so
# the first workspace-create/deploy finds every image already local.
wait "$PREWARM_PID" 2>/dev/null || true
mark "[6b/7] prewarm infra + app-base images"

echo "=== [7/7] Write e2e/.env for the walkthrough ==="
cat > "$REPO_ROOT/e2e/.env" <<ENV
E2E_DOMAIN=${DOMAIN}
E2E_BAILEY_URL=${BAILEY_URL}
E2E_ONBOARD_URL=${ONBOARD_URL}
E2E_KEYCLOAK_URL=http://${KC_HOST}:${KC_PORT}
E2E_OPERATOR_EMAIL=tomas.novak@meridianfoods.cz
E2E_OPERATOR_PASSWORD=meridian-operator
E2E_TEAMMATE_EMAIL=marek.horvath@meridianfoods.cz
E2E_TEAMMATE_PASSWORD=meridian-member
E2E_OTLP_HTTP_ENDPOINT=http://${OTEL_CTR}:4318
E2E_OTLP_GRPC_ENDPOINT=http://${OTEL_CTR}:4317
ENV
mark "[7/7] write e2e/.env"
echo "=== bring-up complete ==="
cat "$REPO_ROOT/e2e/.env"
