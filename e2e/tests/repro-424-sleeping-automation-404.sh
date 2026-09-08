#!/usr/bin/env bash
# Live-stack reproduction of issue #424 — "Sleeping automations 404 instead of
# auto-waking". Run it where the e2e walkthrough has already deployed a business
# process (e2e/bringup.sh + npm test), i.e. inside the KVM guest.
#
# Sleeping a stage is NOT by itself what breaks it: the sleep only commits
# active:false locally, so the host keeps its route and answers 5xx, which the
# gate does rehydrate. The break comes from ANY LATER APPLY of the same business
# process — a dev deploy, a promote, a rollback, waking another stage — because
# the driver's compiler skips active:false entries wholesale and so hands
# /ingress/reconcile a desired route set with the sleeping stage's host missing.
# The daemon prunes it, and the ingress then answers Traefik's default 404, which
# wake-on-access ignores (it only fires on a 5xx).
#
# Usage: e2e/tests/repro-424-sleeping-automation-404.sh [BP] [STAGE]
set -uo pipefail

FAILED=0
log()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '   \033[31m✗ FAIL:\033[0m %s\n' "$*"; FAILED=$((FAILED+1)); }
die()  { printf '\033[31m%s\033[0m\n' "$*"; exit 2; }

STAGE="${2:-production}"

TRAEFIK=$(docker ps --format '{{.Names}}' | grep -E '__traefik$' | head -1)
[ -n "$TRAEFIK" ] || die "No <workspace>__traefik container running — deploy a BP first."
WS="${TRAEFIK%__traefik}"
GITOPS=$(docker ps --format '{{.Names}}' | grep -E "^${WS}(-site)?-.*bitswan-gitops|^${WS}-gitops$" | head -1)
[ -n "$GITOPS" ] || die "No gitops container running for workspace $WS."

# The sub-traefik's router table names every host the workspace serves, in the
# gate's inner form; the OUTER host is what a browser asks for and what the
# platform ingress must route.
DYN=$(mktemp); trap 'rm -f "$DYN"' EXIT
routed_hosts() {
  docker cp "$TRAEFIK:/etc/traefik/dynamic.yml" "$DYN" >/dev/null 2>&1 \
    || die "Could not read /etc/traefik/dynamic.yml from $TRAEFIK"
  grep -oE 'Host\(`[^`]+`\)' "$DYN" | sed -E 's/Host\(`(.*)`\)/\1/' | sort -u
}
INNER=$(routed_hosts | grep -E -- "-${STAGE}--inner\." | head -1)
[ -n "$INNER" ] || die "No -$STAGE host routed by $TRAEFIK. Routed hosts:
$(routed_hosts | sed 's/^/  /')"
HOST="${INNER/--inner/}"

SECRET=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$GITOPS" \
  | sed -n 's/^BITSWAN_GITOPS_SECRET=//p' | head -1)
[ -n "$SECRET" ] || die "Could not read BITSWAN_GITOPS_SECRET from $GITOPS."

BP="${1:-}"
if [ -z "$BP" ]; then
  BP=$(docker exec "$GITOPS" sh -c 'ls "${BITSWAN_GITOPS_DIR:-/mnt/repo/pipeline}/gitops/bp"' 2>/dev/null | head -1)
fi
[ -n "$BP" ] || die "Could not derive the business process; pass it as argument 1."
echo "workspace=$WS gitops=$GITOPS bp=$BP stage=$STAGE"
echo "host=$HOST"

gitops_post() {
  docker exec "$GITOPS" curl -sS -m 300 -X POST \
    -H "Authorization: Bearer $SECRET" -H 'Content-Type: application/json' \
    -d "{\"stage\":\"$2\"}" \
    "http://localhost:8079/automations/business-processes/$BP/$1"
}
# Ask for the outer host exactly as a browser does: through the platform ingress
# on 443. Routed => 302 to the IdP (or 2xx); unrouted => Traefik's bare 404.
probe()      { curl -sk -o /dev/null -w '%{http_code}' -m 15 --resolve "$HOST:443:127.0.0.1" "https://$HOST/"; }
probe_body() { curl -sk -m 15 --resolve "$HOST:443:127.0.0.1" "https://$HOST/" | head -c 120; }
on_demand()  {
  docker exec "$GITOPS" curl -sS -m 30 -H "Authorization: Bearer $SECRET" \
    "http://localhost:8079/automations/on-demand-host?host=$HOST"
}

log "1. the deployed $STAGE host is routed while awake"
AWAKE=$(probe)
echo "   HTTP $AWAKE"
[ "$AWAKE" != "404" ] || die "host 404s while awake — the stack is not in a fit state to test"
ok "awake host is routed ($AWAKE)"

log "2. $BP/$STAGE goes to sleep"
gitops_post sleep "$STAGE" | head -c 200; echo
SLEPT=$(probe)
echo "   HTTP $SLEPT"
if [ "$SLEPT" != "404" ]; then
  ok "still routed right after the sleep ($SLEPT) — the sleep alone is not the bug"
else
  fail "already 404 immediately after the sleep"
fi

log "3. the business process is applied again while $STAGE sleeps"
gitops_post sleep dev | head -c 160; echo
gitops_post wake  dev | head -c 220; echo
for _ in $(seq 1 20); do [ "$(probe)" = "404" ] && break; sleep 3; done

log "4. the sleeping host must stay routed and wakeable"
AFTER=$(probe)
echo "   HTTP $AFTER"
echo "   gitops classifies it as: $(on_demand)"
case "$AFTER" in
  404) fail "the route was PRUNED — the host now answers:
       $(probe_body)
     compile() skips active:false deployments wholesale, so the apply handed
     /ingress/reconcile a desired set without this host and the daemon pruned it.
     The ingress answers Traefik's no-such-router 404, the gate's wake-on-access
     only fires on a 5xx, and the request never even reaches the gate — so an
     on_demand host is permanently unreachable instead of waking. This is #424." ;;
  *)   ok "still routed ($AFTER) after the apply" ;;
esac

log "5. restore: wake $BP/$STAGE"
gitops_post wake "$STAGE" | head -c 200; echo

if [ "$FAILED" -gt 0 ]; then
  printf '\n\033[31m%d check(s) failed — #424 reproduced.\033[0m\n' "$FAILED"
  exit 1
fi
printf '\n\033[32mA sleeping automation keeps its route across a re-apply — #424 is fixed.\033[0m\n'
