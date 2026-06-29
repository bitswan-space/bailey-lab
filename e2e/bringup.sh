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

GITOPS_IMAGE="bitswan/gitops-local:latest"
DASHBOARD_IMAGE="bitswan/workspace-dashboard-local:latest"
CODING_AGENT_IMAGE="bitswan/coding-agent-local:latest"
# The per-BP egress firewall gateway. gitops references it by this exact tag
# (BITSWAN_EGRESS_GATEWAY_IMAGE default in automation_service), so a deployed
# firewall can stand up the SNI/Host allow-list proxy that observes egress for
# the dashboard's "needs review" feed. Without this image the gateway service
# can't start and no egress is ever observed.
EGRESS_GATEWAY_IMAGE="bitswan/egress-gateway:latest"

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
npm --prefix bitswan-server-console install --no-audit --no-fund
mark "[1/7] server-console: npm install"
npm --prefix bitswan-server-console run build
mark "[1/7] server-console: vite build"
rm -rf bitswan-automation-server/internal/daemon/serverconsole_dist
mkdir -p bitswan-automation-server/internal/daemon/serverconsole_dist
cp -r bitswan-server-console/dist/. bitswan-automation-server/internal/daemon/serverconsole_dist/
( cd bitswan-automation-server && go build -o bitswan ./main.go )
mark "[1/7] bitswan CLI: go build"
BITSWAN="$REPO_ROOT/bitswan-automation-server/bitswan"
docker build -t "$GITOPS_IMAGE"       -f "$REPO_ROOT/bitswan-gitops/Dockerfile" "$REPO_ROOT"
mark "[1/7] docker build: gitops image"
docker build -t "$DASHBOARD_IMAGE"    -f "$REPO_ROOT/bitswan-workspace-dashboard/Dockerfile" "$REPO_ROOT/bitswan-workspace-dashboard"
mark "[1/7] docker build: dashboard image"
docker build -t "$CODING_AGENT_IMAGE" -f "$REPO_ROOT/bitswan-coding-agent/Dockerfile" "$REPO_ROOT/bitswan-coding-agent"
mark "[1/7] docker build: coding-agent image"
# The egress firewall gateway image (build context = the automation-server repo
# root, per its Dockerfile). gitops deploys this per (bp,stage) when a firewall
# is active, so it must exist locally or the gateway never starts.
docker build -t "$EGRESS_GATEWAY_IMAGE" -f "$REPO_ROOT/bitswan-automation-server/cmd/egress-gateway/Dockerfile" "$REPO_ROOT/bitswan-automation-server"
mark "[1/7] docker build: egress-gateway image"

# The per-workspace infra-driver sidecar runs this image (debian + docker CLI +
# git + git-http-backend) with the bitswan binary mounted at runtime. The
# workspace compose references bitswan/automation-server-runtime:latest and
# brings it up with --pull missing, so build the tag here or the sidecar (the
# only container with docker.sock) can't start and the workspace never comes up.
docker build -t bitswan/automation-server-runtime:latest -f "$REPO_ROOT/bitswan-automation-server/Dockerfile" "$REPO_ROOT/bitswan-automation-server"
mark "[1/7] docker build: automation-server-runtime image"

echo "=== [2/7] Daemon + traefik ingress ==="
# Pin the daemon to THIS checkout's images so workspaces it creates via the
# Server Console UI run the branch's gitops/dashboard/coding-agent (with the
# features the manual documents) instead of Docker Hub 'latest'. sudo strips the
# environment, so set it explicitly on the command via `env`.
sudo env \
  BITSWAN_GITOPS_IMAGE="$GITOPS_IMAGE" \
  BITSWAN_DASHBOARD_IMAGE="$DASHBOARD_IMAGE" \
  BITSWAN_CODING_AGENT_IMAGE="$CODING_AGENT_IMAGE" \
  "$BITSWAN" automation-server-daemon init
sleep 5
"$BITSWAN" automation-server-daemon status
# `ingress init` makes the daemon pull + start traefik; on a cold host that pull
# can exceed the daemon client's request deadline. Pre-pull, then retry.
docker pull traefik:v3.6 >/dev/null 2>&1 || true
for i in 1 2 3 4 5; do
  "$BITSWAN" ingress init --type traefik -v && break
  echo "ingress init attempt $i timed out; traefik image now warming, retrying..."; sleep 12
done
docker ps | grep -q traefik || { echo "ERROR: traefik not running"; exit 1; }

mark "[2/7] daemon + traefik ingress"
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
sleep 3
docker ps | grep -q "$OTEL_CTR" || { echo "ERROR: otel-collector not running"; docker logs --tail 50 "$OTEL_CTR"; exit 1; }

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
  -e OAUTH2_PROXY_INSECURE_OIDC_ALLOW_UNVERIFIED_EMAIL=true \
  quay.io/oauth2-proxy/oauth2-proxy:v7.6.0
sleep 3
docker ps | grep -q bitswan-protected-proxy || { echo "ERROR: protected proxy not running"; docker logs --tail 50 bitswan-protected-proxy; exit 1; }

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
