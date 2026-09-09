#!/usr/bin/env bash
set -uo pipefail

WS="${1:-repro413}"
HEADROOM="${2:-1200K}"
G="$(sudo docker ps --format '{{.Names}}' | grep -- "-bitswan-gitops-1$" | grep "^$WS" | head -1)"
[ -n "$G" ] || {
  echo "no gitops container for workspace '$WS'."
  echo "stand the platform up with e2e/local-vm/run-bringup-only.sh, then:"
  echo "  bitswan workspace init --local --dev $WS"
  exit 2
}
TOK=$(sudo docker inspect "$G" -f '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^BITSWAN_GITOPS_SECRET=//p')
PG="${WS}__postgres-dev"
VOL="${WS}_${WS}-postgres-dev-data-data"
DATA="/var/lib/docker/volumes/$VOL/_data"

api() { sudo docker exec "$G" sh -c "curl -s -m 300 $* -H 'Authorization: Bearer $TOK'"; }
psqlq() { sudo docker exec "$PG" psql -U admin -d postgres -t -A -c "$1"; }
show_databases() { echo "    databases: $(psqlq 'SELECT datname FROM pg_database ORDER BY 1' | tr '\n' ' ')"; }
free_disk() { sudo rm -f "$DATA/fill"; echo "    $(sudo df -h "$DATA" | tail -1)"; }
fill_disk() {
  sudo dd if=/dev/zero of="$DATA/fill" bs=1M count=100000 status=none 2>/dev/null
  sudo truncate -s -"$HEADROOM" "$DATA/fill"
  echo "    $(sudo df -h "$DATA" | tail -1)"
}
await_postgres_healthy() {
  for _ in $(seq 1 60); do
    [ "$(sudo docker inspect "$PG" -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')" = healthy ] && return 0
    sleep 5
  done
  echo "    postgres never came back healthy"
  return 1
}
watch_task() {
  for _ in $(seq 1 90); do
    out=$(api "http://127.0.0.1:8079/automations/deploy-status/$1")
    st=$(printf '%s' "$out" | tr ',' '\n' | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p' | head -1)
    case "$st" in
    completed | failed)
      echo "    task status: $st"
      printf '%s' "$out" | tr ',' '\n' | grep '"error"' | sed 's/^/    /' | head -2
      return 0
      ;;
    esac
    sleep 8
  done
  echo "    timed out waiting for task $1"
}
task_of() { printf '%s' "$1" | sed -n 's/.*"deploy_task_id":"\([^"]*\)".*/\1/p'; }
show_last_deploy() {
  url="http://127.0.0.1:8079/automations/business-processes/$1/last-deploy?stage=$2${3:+&copy=$3}"
  echo "    GET ${url#http://127.0.0.1:8079}"
  api "'$url'" | sed 's/^/      /'
  echo
}

await_gitops_ready() {
  for _ in $(seq 1 60); do
    code=$(api "-o /dev/null -w '%{http_code}' http://127.0.0.1:8079/automations/")
    case "$code" in 2*) return 0 ;; esac
    sleep 5
  done
  echo "gitops for '$WS' never started answering (last HTTP code: ${code:-none})"
  exit 1
}

echo "### Issue #413: running out of disk during a business process's FIRST deploy."
echo "### The disk is filled only under the workspace postgres, where the issue"
echo "### filled it, so image builds are unaffected."
echo
echo "=== wait for the workspace gitops to accept requests"
await_gitops_ready
echo "    ready"

echo "=== cap postgres-dev's data directory (tmpfs) so it can be filled on demand"
sudo docker volume inspect "$VOL" >/dev/null 2>&1 || sudo docker volume create \
  --label com.docker.compose.project="$WS" \
  --label com.docker.compose.volume="${WS}-postgres-dev-data-data" "$VOL" >/dev/null
sudo mkdir -p "$DATA"
sudo mountpoint -q "$DATA" || sudo mount -t tmpfs -o size=400M tmpfs "$DATA"
echo "    $(sudo df -h "$DATA" | tail -1)"

echo
echo "=== [1] a first business process, with room to spare — the baseline"
r=$(api "-X POST http://127.0.0.1:8079/processes/ -H 'Content-Type: application/json' -d '{\"name\":\"gradesta\"}'")
echo "    $r"
watch_task "$(task_of "$r")"
show_databases

echo
echo "=== [2] fill postgres's disk, then create a second one: its FIRST deploy to dev"
fill_disk
r=$(api "-X POST http://127.0.0.1:8079/processes/ -H 'Content-Type: application/json' -d '{\"name\":\"ledger\"}'")
echo "    $r"
watch_task "$(task_of "$r")"
show_databases
echo "    the container the failed apply left running against a missing database:"
sudo docker ps -a --filter "label=gitops.workspace=$WS" --filter "label=gitops.deployment_id=backend-ledger-dev" --format '      {{.ID}}  {{.Status}}'

echo
echo "=== [3] the failure OUTLIVES the deploy task, so a reloaded Deploy screen"
echo "===     can say what went wrong instead of 'All deployed and up to date'"
show_last_deploy ledger dev
echo "    and git divergence still reads level with main — which is why this"
echo "    reading has to exist at all:"
api "http://127.0.0.1:8079/copies/main/divergence?bp=ledger" 2>/dev/null | sed 's/^/      /'
echo

echo "=== [4] the operator frees disk space and presses Retry"
free_disk
await_postgres_healthy
r=$(api "-X POST http://127.0.0.1:8079/automations/deploy-bp -H 'Content-Type: application/json' -d '{\"bp\":\"ledger\",\"stage\":\"dev\"}'")
watch_task "$(printf '%s' "$r" | sed -n 's/.*"task_id":"\([^"]*\)".*/\1/p')"
show_databases
echo "    container id (unchanged — the retry must provision it anyway):"
sudo docker ps -a --filter "label=gitops.workspace=$WS" --filter "label=gitops.deployment_id=backend-ledger-dev" --format '      {{.ID}}  {{.Status}}'
show_last_deploy ledger dev

echo "=== [5] the same scenario for a copy's live-dev, whose per-copy database"
echo "===     has no best-effort second pass behind it"
api "-X POST http://127.0.0.1:8079/copies/create -H 'Content-Type: application/json' -d '{\"branch_name\":\"tomas\",\"kind\":\"user\",\"owner\":\"tomas.novak@meridianfoods.cz\"}'" >/dev/null
sleep 20
fill_disk
r=$(api "-X POST http://127.0.0.1:8079/processes/ -H 'Content-Type: application/json' -d '{\"name\":\"payroll\",\"copy\":\"tomas\"}'")
echo "    $r"
watch_task "$(task_of "$r")"
show_last_deploy payroll live-dev tomas
free_disk
await_postgres_healthy
echo "    retry:"
r=$(api "-X POST http://127.0.0.1:8079/automations/deploy-bp -H 'Content-Type: application/json' -d '{\"bp\":\"payroll\",\"stage\":\"live-dev\",\"copy\":\"tomas\"}'")
watch_task "$(printf '%s' "$r" | sed -n 's/.*"task_id":"\([^"]*\)".*/\1/p')"
echo "    copy_tomas_bp_payroll present? (1 = the retry repaired it)"
psqlq "SELECT count(*) FROM pg_database WHERE datname='copy_tomas_bp_payroll'" | sed 's/^/      /'
show_last_deploy payroll live-dev tomas
echo "    the backend's own view:"
sudo docker logs --tail 2 "$(sudo docker ps -q --filter "label=gitops.workspace=$WS" --filter 'label=gitops.deployment_id=backend-copy-tomas-payroll-live-dev')" 2>&1 | sed 's/^/      /'
