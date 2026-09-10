#!/usr/bin/env bash
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
export NAMESPACE_MEMORY="${E2E_K8S_MEMORY:-10Gi}"
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
export INFRA_DRIVER_IMAGE="bitswan/infra-driver-k8s:dev"
export EGRESS_GATEWAY_IMAGE="bitswan/egress-gateway-dev:latest"
export WORKSPACE_API_TOKEN="${E2E_WORKSPACE_API_TOKEN:-workspace-api-e2e-token}"
export REGISTRY_IMAGE="registry:2"
export BUILDKIT_IMAGE="moby/buildkit:v0.19.0-rootless"
export REGISTRY_STORAGE="${E2E_K8S_REGISTRY_STORAGE:-10Gi}"
export REGISTRY_NODE_PORT="${E2E_K8S_REGISTRY_NODE_PORT:-30500}"

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

SUBST='${NAMESPACE} ${DOMAIN} ${STORAGE_SIZE} ${NAMESPACE_MEMORY} ${PULL_POLICY} ${DAEMON_IMAGE}
${TRAEFIK_IMAGE} ${PROXY_IMAGE} ${REDIS_IMAGE} ${KEYCLOAK_IMAGE} ${OTEL_IMAGE}
${KC_HOST} ${KC_PORT} ${OIDC_ISSUER} ${OIDC_HOST} ${OIDC_CLIENT_ID}
${OIDC_CLIENT_SECRET} ${OIDC_COOKIE_SECRET} ${REALM_JSON_INDENTED}
${OTEL_CONFIG_INDENTED} ${GITOPS_IMAGE} ${DASHBOARD_IMAGE}
${CODING_AGENT_IMAGE} ${INFRA_DRIVER_IMAGE} ${EGRESS_GATEWAY_IMAGE}
${WORKSPACE_API_TOKEN} ${REGISTRY_IMAGE}
${BUILDKIT_IMAGE} ${REGISTRY_STORAGE} ${REGISTRY_NODE_PORT}'

if [ "${E2E_K8S_RESET:-1}" = "1" ]; then
  echo "=== [0/5] delete namespace ${NAMESPACE} so the server is unclaimed ==="
  $KUBECTL delete namespace "$NAMESPACE" --wait=true --timeout=300s >/dev/null 2>&1 || true
  if $KUBECTL get namespace "$NAMESPACE" >/dev/null 2>&1; then
    echo "ERROR: namespace $NAMESPACE survived deletion; the suite needs an unclaimed server." >&2
    exit 1
  fi
  mark "k8s: reset"
fi

echo "=== [1/5] namespace ${NAMESPACE} ==="
$KUBECTL create namespace "$NAMESPACE" --dry-run=client -o yaml | $KUBECTL apply -f -
$KUBECTL label --overwrite namespace "$NAMESPACE" pod-security.kubernetes.io/enforce=privileged
mark "k8s: namespace"

echo "=== [2/5] harness: keycloak (seeded realm) + otlp collector ==="
export REALM_JSON_INDENTED="$(sed 's/^/    /' "$REPO_ROOT/e2e/keycloak/realm-export.json")"
export OTEL_CONFIG_INDENTED="$(sed 's/^/    /' "$REPO_ROOT/e2e/otel/collector-config.yaml")"
$KUBECTL create namespace "$HARNESS_NAMESPACE" --dry-run=client -o yaml | $KUBECTL apply -f -
envsubst "$SUBST" < "$HERE/keycloak.yaml.template" | $KUBECTL -n "$HARNESS_NAMESPACE" apply -f -
envsubst "$SUBST" < "$HERE/otel.yaml.template" | $KUBECTL -n "$NAMESPACE" apply -f -
$KUBECTL -n "$HARNESS_NAMESPACE" rollout status deploy/keycloak --timeout=300s
$KUBECTL -n "$NAMESPACE" rollout status deploy/bitswan-e2e-otel --timeout=180s
mark "k8s: harness (keycloak + otel)"

echo "=== [2b/5] the builder and the registry ==="
envsubst "$SUBST" < "$HERE/build.yaml.template" | $KUBECTL -n "$NAMESPACE" apply -f -
$KUBECTL -n "$NAMESPACE" rollout status deploy/bitswan-registry --timeout=300s
$KUBECTL -n "$NAMESPACE" rollout status deploy/bitswan-buildkit --timeout=300s
mark "k8s: builder + registry"

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

echo "=== [5b/5] every pod is Ready ==="
notready="$($KUBECTL -n "$NAMESPACE" get pods --no-headers \
  --field-selector=status.phase!=Succeeded 2>/dev/null \
  | awk '$2 != "1/1" && $2 != "4/4" && $2 != "2/2" && $2 != "3/3" { print }')"
if [ -n "$notready" ]; then
  echo "ERROR: not every pod is Ready after bring-up:" >&2
  echo "$notready" >&2
  for p in $(echo "$notready" | awk '{print $1}'); do
    echo "--- $p ---" >&2
    $KUBECTL -n "$NAMESPACE" logs "$p" --all-containers --tail=20 >&2 2>&1 || true
  done
  exit 1
fi
$KUBECTL -n "$NAMESPACE" get pods
mark "k8s: every pod ready"

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
