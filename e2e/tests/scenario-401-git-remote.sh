#!/usr/bin/env bash
set -uo pipefail

usage() {
  cat <<USAGE
usage: $0 [<workspace-gitops-container> [<bp-slug>]]

Exercises issue #401 (workspace git remote) end to end against a running
workspace: starts a throwaway SSH git server on bitswan_network, registers the
workspace's deploy key on it, points the workspace at it through the gitops API,
pushes, and verifies the remote holds one folder per business process on the
dev and gitops branches. Then it commits directly on the remote's dev branch and
checks the next push reports "diverged" instead of overwriting it.

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
api -X POST localhost:8079/workspace/git-remote/push >/dev/null
status="$(wait_for_push)" || fail "the push did not finish within 3 minutes"
result="$(printf '%s' "$status" | json status.result)"
echo "push result: $result"
if [ "$result" != "ok" ]; then
  echo "$status" | python3 -m json.tool >&2
  fail "first push result is '$result' (error: $(printf '%s' "$status" | json status.error))"
fi

refs="$(docker exec "$GITSRV" git --git-dir="$REPO" for-each-ref --format='%(refname)')"
echo "$refs" | grep -qx 'refs/heads/dev' || fail "remote has no dev branch"
echo "$refs" | grep -qx 'refs/heads/gitops' || fail "remote has no gitops branch"
echo "$refs" | grep -q '^refs/heads/copies/' || fail "remote has no copies/* branch"
echo "$refs" | grep -q '^refs/heads/staging$' && echo "staging present" || echo "staging absent (nothing promoted yet)"

docker exec "$GITSRV" git --git-dir="$REPO" ls-tree --name-only dev | grep -qx "$BP" \
  || fail "dev branch has no $BP/ folder"
docker exec "$GITSRV" git --git-dir="$REPO" ls-tree --name-only gitops | grep -qx "$BP" \
  || fail "gitops branch has no $BP/ folder"
docker exec "$GITSRV" git --git-dir="$REPO" cat-file -e "gitops:$BP/bitswan.yaml" \
  || fail "gitops branch has no $BP/bitswan.yaml"

remote_dev="$(docker exec "$GITSRV" git --git-dir="$REPO" rev-parse refs/heads/dev)"
reported="$(printf '%s' "$status" | json status.branches.dev.remote)"
[ "$remote_dev" = "$reported" ] || fail "status reports dev at '$reported' but the remote is at $remote_dev"

echo "=== divergence is reported, never overwritten ==="
docker exec "$GITSRV" sh -c "
  rm -rf /tmp/dev && git clone -q --branch dev $REPO /tmp/dev &&
  cd /tmp/dev && echo edited > $BP/EDITED-ON-REMOTE &&
  git -c user.email=x@y -c user.name=x add -A &&
  git -c user.email=x@y -c user.name=x commit -qm 'foreign edit' &&
  git push -q origin dev" || fail "could not create a foreign commit on the remote"
foreign="$(docker exec "$GITSRV" git --git-dir="$REPO" rev-parse refs/heads/dev)"

api -X POST localhost:8079/workspace/git-remote/push >/dev/null
status="$(wait_for_push)" || fail "the second push did not finish"
[ "$(printf '%s' "$status" | json status.branches.dev.result)" = "diverged" ] \
  || fail "dev was not reported as diverged: $(printf '%s' "$status" | json status.branches.dev.result)"
[ "$(docker exec "$GITSRV" git --git-dir="$REPO" rev-parse refs/heads/dev)" = "$foreign" ] \
  || fail "the remote's dev branch was overwritten"

docker exec "$GITSRV" git --git-dir="$REPO" update-ref refs/heads/dev "$remote_dev"
api -X POST localhost:8079/workspace/git-remote/push >/dev/null
status="$(wait_for_push)" || fail "the third push did not finish"
case "$(printf '%s' "$status" | json status.branches.dev.result)" in
  pushed | up_to_date) ;;
  *) fail "dev did not recover after resetting the remote: $(printf '%s' "$status" | json status.branches.dev.result)" ;;
esac

echo "=== clear ==="
resp="$(api -X DELETE localhost:8079/workspace/git-remote)"
[ -z "$(printf '%s' "$resp" | json url)" ] || fail "DELETE left the url set"

if [ "$FAILED" = "0" ]; then
  echo "PASS: workspace mirrored to $URL with $BP/ on dev and gitops, divergence reported, remote cleared"
  exit 0
fi
exit 1
