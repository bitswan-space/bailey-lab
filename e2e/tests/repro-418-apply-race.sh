#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<USAGE
usage: $0 [<workspace-gitops-container> [<copy-name> [<attempts>]]]

Reproduces issue #418 ("docker compose up failed when creating a new bp").

Two applies for the same business process run "docker compose -p <workspace>
up -d" at the same time - the setup deploy that BP creation kicks off, and the
live-dev wake the BP page fires - and nothing serialises them. Whichever loses
the race asks Docker to create a container the winner has just created and gets

  Conflict. The container name "/<ws>-frontend-<hash>-live-dev" is already in use

which is reported to the operator only as

  driver apply failed: docker compose up failed: exit status 1

Exits non-zero once it observes that, so it fails while the bug is present.
The copy must already exist in the workspace (opening the dashboard creates it).
USAGE
}

case "${1:-}" in -h | --help) usage; exit 0 ;; esac

GITOPS="${1:-}"
COPY="${2:-}"
ATTEMPTS="${3:-3}"
REQUESTER="${E2E_REPRO_EMAIL:-tomas.novak@meridianfoods.cz}"

if [ -z "$GITOPS" ]; then
  GITOPS="$(docker ps --format '{{.Names}}' | grep -m1 -- '-site-bitswan-gitops-1')"
fi
[ -n "$GITOPS" ] || { echo "no workspace gitops container found; pass one" >&2; exit 2; }

TOKEN="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$GITOPS" \
  | sed -n 's/^BITSWAN_GITOPS_SECRET=//p')"
[ -n "$TOKEN" ] || { echo "could not read BITSWAN_GITOPS_SECRET from $GITOPS" >&2; exit 2; }

api() {
  docker exec "$GITOPS" curl -s -m 200 \
    -H "Authorization: Bearer $TOKEN" \
    -H "X-Forwarded-Email: $REQUESTER" \
    -H 'Content-Type: application/json' "$@"
}

if [ -z "$COPY" ]; then
  COPY="$(printf '%s' "$REQUESTER" | tr '@.' '--')"
fi

json_field() { python3 -c "import json,sys; print(json.load(sys.stdin).get('$1') or '')"; }

echo "workspace gitops: $GITOPS"
echo "copy:             $COPY"

for attempt in $(seq 1 "$ATTEMPTS"); do
  bp="race418-$(date +%s)-$attempt"
  echo
  echo "=== attempt $attempt/$ATTEMPTS: create \"$bp\" in the copy, then wake it while its setup deploy runs"

  created="$(api -X POST -d "{\"name\":\"$bp\",\"copy\":\"$COPY\",\"created_by\":\"$REQUESTER\"}" \
    localhost:8079/processes/)"
  slug="$(printf '%s' "$created" | json_field name)"
  task="$(printf '%s' "$created" | json_field deploy_task_id)"
  if [ -z "$slug" ] || [ -z "$task" ]; then
    echo "creating the business process did not return a slug + deploy task: $created" >&2
    exit 2
  fi
  echo "    slug=$slug setup-deploy-task=$task"

  (
    sleep 3
    for _ in $(seq 1 60); do
      api -X POST -d "{\"copy\":\"$COPY\"}" \
        "localhost:8079/automations/business-processes/$slug/wake-live-dev" >/dev/null 2>&1
    done
  ) &
  waker=$!

  status=""
  for _ in $(seq 1 60); do
    body="$(api "localhost:8079/automations/deploy-status/$task")"
    status="$(printf '%s' "$body" | json_field status)"
    printf '    %s | %s\n' "$status" "$(printf '%s' "$body" | json_field message | cut -c1-120)"
    [ "$status" = "in_progress" ] || [ "$status" = "pending" ] || break
    sleep 5
  done
  kill "$waker" 2>/dev/null
  wait "$waker" 2>/dev/null

  setup_log="$(api "localhost:8079/automations/deploy-status/$task")"
  wake_log="$(docker logs --tail 400 "$GITOPS" 2>&1 | grep -iE "wake redeploy of .*$slug.* failed" | tail -3)"

  if printf '%s' "$setup_log" | grep -q "compose up failed"; then
    echo
    echo "#418 reproduced: the setup deploy of \"$slug\" lost the race."
    printf '%s' "$setup_log" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for line in (d.get("log") or [])[-12:]:
    print("   ", line[:300])
print("    error:", d.get("error"))'
    exit 1
  fi

  if [ -n "$wake_log" ]; then
    echo
    echo "#418 reproduced: the live-dev wake of \"$slug\" lost the race."
    echo "$wake_log" | sed 's/^/    /'
    docker logs --tail 400 "$GITOPS" 2>&1 | grep -iE "already in use|Conflict\." | tail -3 | sed 's/^/    /'
    exit 1
  fi

  echo "    no collision this attempt (both applies happened to serialise)"
done

echo
echo "no collision in $ATTEMPTS attempts - the race did not land, which is not proof it is fixed"
exit 0
