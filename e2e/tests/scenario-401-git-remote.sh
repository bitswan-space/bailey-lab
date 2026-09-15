#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<USAGE
usage: $0 [<workspace-gitops-container> [<bp-slug>]]

Exercises issue #401 (workspace git remote) end to end against a running
workspace: starts a throwaway SSH git server on bitswan_network, registers the
workspace's deploy key on it, points the workspace at it through the gitops API,
pushes, and verifies the remote's main holds one folder per business process
plus a README, and gitops holds the manifests. Then it commits on the remote's
main and checks the pull brings that commit into the process's own main, and
finally rewrites the remote's main and checks the push is refused as diverged
until an admin force-pushes to repair.

Run it after a business process has been deployed to dev (the walkthrough's
deploy chapter). Exit 0 = every check passed, 1 = a check failed, 2 = setup.
Set KEEP=1 to leave the git server container running for inspection.
USAGE
}

case "${1:-}" in -h | --help) usage; exit 0 ;; esac

GITOPS="${1:-}"
BP="${2:-}"
REQUESTER="${E2E_REPRO_EMAIL:-tomas.novak@meridianfoods.cz}"
GITSRV="bitswan-e2e-gitsrv"
GITSRV_IMAGE="${GITSRV_IMAGE:-alpine:3.20}"
REPO="/srv/git/workspace.git"

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

json() { python3 -c "import json,sys; d=json.load(sys.stdin)
for k in '$1'.split('.'):
    d = d.get(k) if isinstance(d, dict) else None
print('' if d is None else d)"; }

fail() { echo "FAIL: $*" >&2; FAILED=1; }
FAILED=0

cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then
    echo "keeping $GITSRV running (KEEP=1)"
  else
    docker rm -f "$GITSRV" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "workspace gitops: $GITOPS"

if [ -z "$BP" ]; then
  BP="$(docker exec "$GITOPS" sh -c 'ls /git 2>/dev/null | sed -n "s/\.git$//p" | head -1')"
fi
[ -n "$BP" ] || { echo "no business process found; pass one" >&2; exit 2; }
echo "business process: $BP"

echo "=== throwaway SSH git server ($GITSRV_IMAGE) ==="
docker rm -f "$GITSRV" >/dev/null 2>&1 || true
docker run -d --name "$GITSRV" --network bitswan_network "$GITSRV_IMAGE" sh -c '
  apk add --no-cache openssh git >/dev/null &&
  ssh-keygen -A &&
  adduser -D -s /bin/sh git && passwd -u git >/dev/null &&
  mkdir -p /home/git/.ssh /srv/git &&
  git init -q --bare --initial-branch=main '"$REPO"' &&
  chown -R git:git /home/git /srv/git &&
  exec /usr/sbin/sshd -D -e' >/dev/null || { echo "could not start $GITSRV" >&2; exit 2; }
for _ in $(seq 1 60); do
  docker exec "$GITSRV" pgrep sshd >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$GITSRV" pgrep sshd >/dev/null 2>&1 || { docker logs "$GITSRV" >&2; echo "sshd never came up" >&2; exit 2; }
rgit() { docker exec "$GITSRV" git --git-dir="$REPO" "$@"; }

echo "=== deploy key ==="
PUBKEY="$(api localhost:8079/workspace/git-remote | json public_key)"
case "$PUBKEY" in ssh-ed25519\ *) ;; *) echo "no ssh-ed25519 public key from gitops: '$PUBKEY'" >&2; exit 2 ;; esac
printf '%s\n' "$PUBKEY" | docker exec -i "$GITSRV" sh -c '
  cat >> /home/git/.ssh/authorized_keys &&
  chmod 700 /home/git/.ssh && chmod 600 /home/git/.ssh/authorized_keys &&
  chown -R git:git /home/git/.ssh'
echo "registered: ${PUBKEY:0:40}..."

echo "=== configure the remote ==="
code="$(api -o /dev/null -w '%{http_code}' -X PUT localhost:8079/workspace/git-remote \
  -d '{"url":"https://github.com/acme/workspace.git"}')"
[ "$code" = "400" ] || fail "an https remote was accepted (HTTP $code); only SSH remotes should be"

URL="ssh://git@$GITSRV/$REPO"
resp="$(api -X PUT localhost:8079/workspace/git-remote -d "{\"url\":\"$URL\"}")"
[ "$(printf '%s' "$resp" | json url)" = "$URL" ] || { echo "PUT did not echo the url: $resp" >&2; FAILED=1; }

wait_for_push() {
  for _ in $(seq 1 60); do
    sleep 3
    status="$(api localhost:8079/workspace/git-remote)"
    if [ "$(printf '%s' "$status" | json status.in_progress)" = "False" ] \
      && [ -n "$(printf '%s' "$status" | json status.last_attempt_at)" ]; then
      printf '%s' "$status"
      return 0
    fi
  done
  printf '%s' "$status"
  return 1
}

echo "=== first push ==="
status="$(wait_for_push)" || fail "the first push did not finish within 3 minutes"
result="$(printf '%s' "$status" | json status.result)"
echo "push result: $result"
if [ "$result" != "ok" ]; then
  echo "$status" | python3 -m json.tool >&2
  fail "first push result is '$result' (error: $(printf '%s' "$status" | json status.error))"
fi

refs="$(rgit for-each-ref --format='%(refname)')"
echo "$refs" | grep -qx 'refs/heads/main' || fail "remote has no main branch"
echo "$refs" | grep -qx 'refs/heads/gitops' || fail "remote has no gitops branch"
echo "$refs" | grep -q '^refs/heads/\(dev\|staging\|production\|copies/\)' && fail "remote grew stage or copy branches: $refs"
rgit ls-tree --name-only main | grep -qx "$BP" || fail "main has no $BP/ folder"
rgit ls-tree --name-only main | grep -qx "README.md" || fail "main has no README.md"
rgit show main:README.md | grep -q "fast-forward" || fail "README.md does not explain that main is fast-forward only"
rgit show main:README.md | grep -q "support@bitswan.ai" || fail "README.md has no support address"
rgit ls-tree --name-only gitops | grep -qx "$BP" || fail "gitops branch has no $BP/ folder"
rgit cat-file -e "gitops:$BP/bitswan.yaml" || fail "gitops branch has no $BP/bitswan.yaml"
bp_main_before="$(docker exec "$GITOPS" git --git-dir="/git/$BP.git" rev-parse main)"
[ "$(rgit rev-parse "main:$BP")" = "$(docker exec "$GITOPS" git --git-dir="/git/$BP.git" rev-parse 'main^{tree}')" ] \
  || fail "the $BP/ folder on the remote does not match the process's main tree"

echo "=== a commit added on the remote is pulled into the process's main ==="
docker exec "$GITSRV" sh -c "
  rm -rf /tmp/work && git clone -q --branch main $REPO /tmp/work &&
  cd /tmp/work && echo 'edited on the remote' > $BP/EDITED-ON-REMOTE.md &&
  git -c user.email=reviewer@example.com -c user.name=reviewer add -A &&
  git -c user.email=reviewer@example.com -c user.name=reviewer commit -qm 'Add a note from the remote' &&
  git push -q origin main" || fail "could not commit on the remote's main"
remote_tip="$(rgit rev-parse main)"

pull="$(api -X POST localhost:8079/workspace/git-remote/pull)"
echo "pull result: $(printf '%s' "$pull" | json result)"
[ "$(printf '%s' "$pull" | json result)" = "inbound" ] || { echo "$pull" >&2; fail "the pull did not report inbound changes"; }
printf '%s' "$pull" | python3 -c "import json,sys; sys.exit(0 if '$BP' in json.load(sys.stdin).get('inbound', []) else 1)" \
  || fail "the pull did not list $BP as pulled"
bp_main_after="$(docker exec "$GITOPS" git --git-dir="/git/$BP.git" rev-parse main)"
[ "$bp_main_after" != "$bp_main_before" ] || fail "the process's main did not move after the pull"
[ "$(docker exec "$GITOPS" git --git-dir="/git/$BP.git" rev-parse 'main^')" = "$bp_main_before" ] \
  || fail "the pulled commit is not a fast-forward of the previous main"
[ "$(docker exec "$GITOPS" git --git-dir="/git/$BP.git" show "main:EDITED-ON-REMOTE.md")" = "edited on the remote" ] \
  || fail "the remote's edit did not reach the process's main"
[ "$(rgit rev-parse main)" = "$remote_tip" ] || fail "the pull rewrote the remote's main"

echo "=== a rewritten remote main is diverged until an admin repairs it ==="
docker exec "$GITSRV" sh -c "
  cd /tmp/work && git checkout -q --orphan rewrite && echo x > unrelated.txt &&
  git -c user.email=x@y -c user.name=x add -A &&
  git -c user.email=x@y -c user.name=x commit -qm 'history rewritten' &&
  git push -q --force origin rewrite:main" || fail "could not rewrite the remote's main"
rewritten="$(rgit rev-parse main)"
pull="$(api -X POST localhost:8079/workspace/git-remote/pull)"
[ "$(printf '%s' "$pull" | json result)" = "diverged" ] || { echo "$pull" >&2; fail "a rewritten remote main was not reported as diverged"; }
[ "$(rgit rev-parse main)" = "$rewritten" ] || fail "a diverged remote main was overwritten without a repair"

repaired="$(api -X POST localhost:8079/workspace/git-remote/force-push)"
[ "$(printf '%s' "$repaired" | json status.result)" = "ok" ] || { echo "$repaired" >&2; fail "force push to repair did not succeed"; }
rgit ls-tree --name-only main | grep -qx "$BP" || fail "after the repair main has no $BP/ folder"
[ "$(rgit rev-parse main)" != "$rewritten" ] || fail "the repair did not replace the rewritten main"

echo "=== pause, resume, clear ==="
paused="$(api -X POST localhost:8079/workspace/git-remote/pause)"
[ "$(printf '%s' "$paused" | json paused)" = "True" ] || fail "pause did not set the paused flag"
[ "$(api -X POST localhost:8079/workspace/git-remote/pull | json result)" = "paused" ] || fail "a paused remote still pulls"
resumed="$(api -X POST localhost:8079/workspace/git-remote/resume)"
[ "$(printf '%s' "$resumed" | json paused)" = "False" ] || fail "resume did not clear the paused flag"
resp="$(api -X DELETE localhost:8079/workspace/git-remote)"
[ -z "$(printf '%s' "$resp" | json url)" ] || fail "DELETE left the url set"

if [ "$FAILED" = "0" ]; then
  echo "PASS: $BP mirrored to $URL on main and gitops, remote commits pulled into main, rewritten main repaired, remote cleared"
  exit 0
fi
exit 1
