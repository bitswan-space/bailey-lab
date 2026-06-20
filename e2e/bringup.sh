#!/usr/bin/env bash
# Stand up the REAL bitswan stack for the BP-lifecycle E2E: the daemon, traefik,
# a disposable Keycloak (the only "mock" — a real Keycloak with a seeded realm),
# gitops, the dashboard and the coding-agent — then create a workspace with the
# dashboard wired to that Keycloak. Everything else is real docker: real
# deploys, real snapshots, real blue-green slots, real ingress reconcile.
#
# Prereqs the CI workflow sets up (see .github/workflows/bp-lifecycle-e2e.yml):
#   - docker + docker compose, dnsmasq resolving *.localhost -> 127.0.0.1,
#   - mkcert CA installed (so traefik serves trusted *.bs-e2e.localhost certs),
#   - run as a user that can `sudo` the daemon init.
#
# Usage: e2e/bringup.sh   (run from the repo root)
# Outputs the workspace URLs and writes e2e/.env for the Playwright suite.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WS="e2e"
DOMAIN="bs-e2e.localhost"
KC_HOST="keycloak.${DOMAIN}"
KC_PORT="8088"
DASHBOARD_URL="https://${WS}-dashboard.${DOMAIN}"

GITOPS_IMAGE="bitswan/gitops-local:latest"
DASHBOARD_IMAGE="bitswan/workspace-dashboard-local:latest"
CODING_AGENT_IMAGE="bitswan/coding-agent-local:latest"

echo "=== [1/6] Build the bitswan CLI + component images from this checkout ==="
( cd bitswan-automation-server && go build -o bitswan ./main.go )
BITSWAN="$REPO_ROOT/bitswan-automation-server/bitswan"
docker build -t "$GITOPS_IMAGE"        -f "$REPO_ROOT/bitswan-gitops/Dockerfile" "$REPO_ROOT"
docker build -t "$DASHBOARD_IMAGE"     -f "$REPO_ROOT/bitswan-workspace-dashboard/Dockerfile" "$REPO_ROOT/bitswan-workspace-dashboard"
docker build -t "$CODING_AGENT_IMAGE"  -f "$REPO_ROOT/bitswan-coding-agent/Dockerfile" "$REPO_ROOT/bitswan-coding-agent"

echo "=== [2/6] Daemon + traefik ingress ==="
sudo "$BITSWAN" automation-server-daemon init
sudo chmod 644 "${HOME}/.config/bitswan/automation_server_config.toml" 2>/dev/null || true
sleep 5
"$BITSWAN" automation-server-daemon status
"$BITSWAN" ingress init --type traefik -v
docker ps | grep -q traefik || { echo "ERROR: traefik not running"; exit 1; }

echo "=== [3/6] Disposable Keycloak (seeded realm) on :${KC_PORT} ==="
# Published on the host port so both the browser (via dnsmasq -> 127.0.0.1) and
# the in-container oauth2-proxy/dashboard (via extra_hosts -> host-gateway) reach
# the SAME issuer URL — so the iss claim matches on both legs. http only
# (sslRequired=none in the realm) to avoid a cert dance for the auth server.
docker rm -f bitswan-e2e-keycloak >/dev/null 2>&1 || true
docker run -d --name bitswan-e2e-keycloak --network bitswan_network \
  -p "${KC_PORT}:8088" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -e KC_HTTP_ENABLED=true -e KC_HTTP_PORT="${KC_PORT}" \
  -e KC_HOSTNAME="http://${KC_HOST}:${KC_PORT}" -e KC_HOSTNAME_BACKCHANNEL_DYNAMIC=true \
  -e KC_PROXY_HEADERS=xforwarded \
  -v "$REPO_ROOT/e2e/keycloak/realm-export.json:/opt/keycloak/data/import/realm-export.json:ro" \
  quay.io/keycloak/keycloak:26.0 \
  start-dev --import-realm --http-port "${KC_PORT}"

echo "Waiting for Keycloak realm to be ready..."
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${KC_PORT}/realms/bitswan/.well-known/openid-configuration" >/dev/null 2>&1; then
    echo "Keycloak ready"; break
  fi
  sleep 3
  [ "$i" = 60 ] && { echo "ERROR: Keycloak did not become ready"; docker logs --tail 50 bitswan-e2e-keycloak; exit 1; }
done

echo "=== [4/6] Create the workspace (dashboard + oauth -> the test Keycloak) ==="
"$BITSWAN" workspace init \
  --local --domain "$DOMAIN" \
  --oauth-config "$REPO_ROOT/e2e/oauth-config.json" \
  --gitops-image "$GITOPS_IMAGE" \
  --dashboard-image "$DASHBOARD_IMAGE" \
  --coding-agent-image "$CODING_AGENT_IMAGE" \
  "$WS"

echo "=== [5/6] Seed the test user as root admin (so swaps/firewall are allowed) ==="
# effectiveRole() returns admin for server_settings['root_admin_email'] without
# needing the interactive device-trust claim flow. Seed it straight into the
# daemon's bailey.db (in the `bitswan` docker volume) so the e2e user is admin.
KCDB="$(docker volume inspect bitswan -f '{{ .Mountpoint }}' 2>/dev/null)/bailey.db"
if command -v sqlite3 >/dev/null 2>&1 && sudo test -f "$KCDB"; then
  sudo sqlite3 "$KCDB" \
    "INSERT INTO server_settings(key,value) VALUES('root_admin_email','e2e-admin@example.com') ON CONFLICT(key) DO UPDATE SET value=excluded.value;" \
    && echo "seeded root admin = e2e-admin@example.com"
else
  echo "NOTE: sqlite3/bailey.db unavailable — role badge may show Member; admin-gated steps (swap, prod firewall) will be skipped by the spec."
fi

echo "=== [6/6] Wait for the dashboard to answer ==="
for i in $(seq 1 60); do
  code="$(curl -sk -o /dev/null -w '%{http_code}' "${DASHBOARD_URL}/" || true)"
  case "$code" in 200|302|401|403) echo "dashboard reachable (HTTP $code)"; break;; esac
  sleep 3
  [ "$i" = 60 ] && { echo "ERROR: dashboard not reachable"; docker ps -a; exit 1; }
done

cat > "$REPO_ROOT/e2e/.env" <<ENV
E2E_DASHBOARD_URL=${DASHBOARD_URL}
E2E_DOMAIN=${DOMAIN}
E2E_WORKSPACE=${WS}
E2E_USER=e2e-admin@example.com
E2E_PASSWORD=e2e-admin-password
ENV
echo "=== bring-up complete ==="
cat "$REPO_ROOT/e2e/.env"
