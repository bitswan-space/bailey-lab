#!/usr/bin/env bash
# Bring up a Bailey in a Kubernetes namespace, on the same domain and with the
# same identity provider the Docker suite uses, so the walkthrough runs against
# it unmodified and its screenshots are comparable.
#
# The Bailey install is deliberately the last two commands, run after everything
# that is not a Bailey is already up:
#   kubectl create namespace <ns>
#   kubectl -n <ns> apply -f <the seed>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/e2e/k8s"
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
KUBECTL="${KUBECTL:-kubectl}"

export NAMESPACE="${E2E_K8S_NAMESPACE:-bitswan}"
export HARNESS_NAMESPACE="${E2E_K8S_HARNESS_NAMESPACE:-bitswan-harness}"
export DOMAIN="${E2E_DOMAIN:-bs-e2e.localhost}"
KC_DOMAIN="${E2E_KC_DOMAIN:-$DOMAIN}"
export KC_HOST="keycloak.${KC_DOMAIN}"
export KC_PORT="8088"
export STORAGE_SIZE="${E2E_K8S_STORAGE:-20Gi}"
export PULL_POLICY="${E2E_K8S_PULL_POLICY:-Never}"

export DAEMON_IMAGE="${E2E_DAEMON_IMAGE:-bitswan/automation-server:dev}"
export TRAEFIK_IMAGE="traefik:v3.6"
export PROXY_IMAGE="quay.io/oauth2-proxy/oauth2-proxy:v7.7.1"
export REDIS_IMAGE="redis:7-alpine"
export KEYCLOAK_IMAGE="quay.io/keycloak/keycloak:26.0"
export OTEL_IMAGE="otel/opentelemetry-collector:0.115.1"
export GITOPS_IMAGE="bitswan/gitops-dev:latest"
export DASHBOARD_IMAGE="bitswan/workspace-dashboard-dev:latest"
export CODING_AGENT_IMAGE="bitswan/coding-agent-dev:latest"

export OIDC_ISSUER="http://${KC_HOST}:${KC_PORT}/realms/bitswan"
export OIDC_HOST="${KC_HOST}:${KC_PORT}"
export OIDC_CLIENT_ID="bailey"
export OIDC_CLIENT_SECRET="bailey-e2e-secret"
export OIDC_COOKIE_SECRET="0123456789abcdef0123456789abcdef"

BAILEY_URL="https://bailey.${DOMAIN}"
ONBOARD_URL="https://bailey-onboard.${DOMAIN}"

if [ -f "$REPO_ROOT/e2e/local-vm/timeline.sh" ]; then
  source "$REPO_ROOT/e2e/local-vm/timeline.sh"
else
  mark() { :; }
fi

# Only the names below are substituted, so the shell fragments inside the
# manifests ($CFG, $(cat …)) survive envsubst untouched.
SUBST='${NAMESPACE} ${DOMAIN} ${STORAGE_SIZE} ${PULL_POLICY} ${DAEMON_IMAGE}
${TRAEFIK_IMAGE} ${PROXY_IMAGE} ${REDIS_IMAGE} ${KEYCLOAK_IMAGE} ${OTEL_IMAGE}
${KC_HOST} ${KC_PORT} ${OIDC_ISSUER} ${OIDC_HOST} ${OIDC_CLIENT_ID}
${OIDC_CLIENT_SECRET} ${OIDC_COOKIE_SECRET} ${REALM_JSON_INDENTED}
${OTEL_CONFIG_INDENTED} ${GITOPS_IMAGE} ${DASHBOARD_IMAGE}
${CODING_AGENT_IMAGE}'

echo "=== [1/5] namespace ${NAMESPACE} ==="
# Command one of the two. The label is part of it: the egress firewall's rule
# installer needs NET_ADMIN, which PodSecurity's restricted profile forbids.
$KUBECTL create namespace "$NAMESPACE" --dry-run=client -o yaml | $KUBECTL apply -f -
$KUBECTL label --overwrite namespace "$NAMESPACE" pod-security.kubernetes.io/enforce=baseline
mark "k8s: namespace"

echo "=== [2/5] harness: keycloak (seeded realm) + otlp collector ==="
export REALM_JSON_INDENTED="$(sed 's/^/    /' "$REPO_ROOT/e2e/keycloak/realm-export.json")"
export OTEL_CONFIG_INDENTED="$(sed 's/^/    /' "$REPO_ROOT/e2e/otel/collector-config.yaml")"
# Keycloak goes in its own namespace: it needs a hostPort so the browser and
# every pod reach the issuer at the same url, and hostPort is forbidden by the
# baseline profile the Bailey's namespace enforces. The collector stays in the
# Bailey's namespace, where the walkthrough's bare-name endpoint resolves.
$KUBECTL create namespace "$HARNESS_NAMESPACE" --dry-run=client -o yaml | $KUBECTL apply -f -
envsubst "$SUBST" < "$HERE/keycloak.yaml.template" | $KUBECTL -n "$HARNESS_NAMESPACE" apply -f -
envsubst "$SUBST" < "$HERE/otel.yaml.template" | $KUBECTL -n "$NAMESPACE" apply -f -
$KUBECTL -n "$HARNESS_NAMESPACE" rollout status deploy/keycloak --timeout=300s
$KUBECTL -n "$NAMESPACE" rollout status deploy/bitswan-e2e-otel --timeout=180s
mark "k8s: harness (keycloak + otel)"

echo "=== [3/5] the Bailey ==="
envsubst "$SUBST" < "$HERE/bailey.yaml.template" > /tmp/bailey-seed.yaml
$KUBECTL -n "$NAMESPACE" apply -f /tmp/bailey-seed.yaml
mark "k8s: apply the seed"

echo "=== [4/5] wait for the control plane ==="
$KUBECTL -n "$NAMESPACE" rollout status deploy/bailey --timeout=420s || {
  echo "--- the control plane did not become ready ---" >&2
  $KUBECTL -n "$NAMESPACE" get pods -o wide >&2
  POD="$($KUBECTL -n "$NAMESPACE" get pod -l app.kubernetes.io/name=bailey -o name | head -1)"
  $KUBECTL -n "$NAMESPACE" describe "$POD" | tail -40 >&2
  $KUBECTL -n "$NAMESPACE" logs "$POD" -c seed-state --tail=30 >&2 || true
  $KUBECTL -n "$NAMESPACE" logs "$POD" -c daemon --tail=40 >&2 || true
  exit 1
}
mark "k8s: control plane ready"

echo "=== [5/5] wait for the onboarding host through the gate chain ==="
for i in $(seq 1 60); do
  code="$(curl -sk -o /dev/null -w '%{http_code}' "${ONBOARD_URL}/" || true)"
  case "$code" in 200|302|401|403) echo "onboarding reachable (HTTP $code)"; break;; esac
  sleep 3
  if [ "$i" = 60 ]; then
    echo "ERROR: onboarding host not reachable (last HTTP $code)" >&2
    POD="$($KUBECTL -n "$NAMESPACE" get pod -l app.kubernetes.io/name=bailey -o name | head -1)"
    $KUBECTL -n "$NAMESPACE" logs "$POD" -c daemon --tail=40 >&2 || true
    $KUBECTL -n "$NAMESPACE" logs "$POD" -c traefik --tail=20 >&2 || true
    $KUBECTL -n "$NAMESPACE" logs "$POD" -c protected-proxy --tail=20 >&2 || true
    exit 1
  fi
done
mark "k8s: onboarding chain ready"

cat > "$REPO_ROOT/e2e/.env" <<ENV
E2E_DOMAIN=${DOMAIN}
E2E_BAILEY_URL=${BAILEY_URL}
E2E_ONBOARD_URL=${ONBOARD_URL}
E2E_KEYCLOAK_URL=http://${KC_HOST}:${KC_PORT}
E2E_OPERATOR_EMAIL=tomas.novak@meridianfoods.cz
E2E_OPERATOR_PASSWORD=meridian-operator
E2E_TEAMMATE_EMAIL=marek.horvath@meridianfoods.cz
E2E_TEAMMATE_PASSWORD=meridian-member
E2E_OTLP_HTTP_ENDPOINT=http://bitswan-e2e-otel:4318
E2E_OTLP_GRPC_ENDPOINT=http://bitswan-e2e-otel:4317
ENV
echo "=== bring-up complete ==="
cat "$REPO_ROOT/e2e/.env"
