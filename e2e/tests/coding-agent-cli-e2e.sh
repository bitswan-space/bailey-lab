#!/usr/bin/env bash
# Real-environment E2E for the bitswan-coding-agent CLI (issue #253).
#
# WHY THIS IS NOT A UNIT TEST: the most common CLI breakage is PATH/environment
# drift — e.g. #247, where copy-detection looked for /workspace/worktrees/ after
# the filesystem was renamed to /workspace/copies/. A mocked unit test happily
# passes with the wrong path hardcoded; only running the REAL binary inside the
# REAL agent container, against the REAL gitops API and a REAL live-dev
# deployment, catches it. So this script execs every subcommand in the running
# agent and asserts real output. It FAILS LOUDLY on the first broken command.
#
# Usage:
#   e2e/tests/coding-agent-cli-e2e.sh [WORKSPACE]
# WORKSPACE defaults to the single running *-coding-agent container's workspace.
set -uo pipefail

WORKSPACE="${1:-}"
FAILED=0
PASS=0

log()  { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
fail() { printf '   \033[31m✗ FAIL:\033[0m %s\n' "$*"; FAILED=$((FAILED+1)); }

# --- locate the coding-agent container -------------------------------------
if [ -z "$WORKSPACE" ]; then
  AGENT=$(docker ps --format '{{.Names}}' | grep -E -- '-coding-agent$' | head -1)
  [ -n "$AGENT" ] || { echo "No *-coding-agent container running; nothing to test."; exit 2; }
  WORKSPACE="${AGENT%-coding-agent}"
else
  AGENT="${WORKSPACE}-coding-agent"
fi
docker inspect "$AGENT" >/dev/null 2>&1 || { echo "Agent container '$AGENT' not found."; exit 2; }
echo "Testing CLI in container: $AGENT (workspace: $WORKSPACE)"

CLI=bitswan-coding-agent
dex() { docker exec "$AGENT" sh -c "$1" 2>&1; }
# Run a CLI command from a given container dir. dexc DIR "CMD..."
dexc() { docker exec "$AGENT" sh -c "cd '$1' 2>/dev/null && $CLI ${*:2}" 2>&1; }

# assert_ok DESC DIR CMD...   -> command must exit 0
assert_ok() {
  local desc="$1" dir="$2"; shift 2
  local out; out=$(docker exec "$AGENT" sh -c "cd '$dir' 2>/dev/null && $CLI $* ; echo __RC=\$?" 2>&1)
  local rc="${out##*__RC=}"; rc="${rc%%$'\n'*}"
  if [ "$rc" = "0" ]; then ok "$desc"; else fail "$desc (rc=$rc)"; printf '     %s\n' "$(echo "$out" | grep -v __RC= | head -3)"; fi
}
# assert_contains DESC DIR PATTERN CMD...  -> command output must match PATTERN
assert_contains() {
  local desc="$1" dir="$2" pat="$3"; shift 3
  local out; out=$(docker exec "$AGENT" sh -c "cd '$dir' 2>/dev/null && $CLI $*" 2>&1)
  if echo "$out" | grep -qE "$pat"; then ok "$desc"; else fail "$desc (no match /$pat/)"; printf '     %s\n' "$(echo "$out" | head -3)"; fi
}
# assert_fails_with DESC DIR PATTERN CMD... -> command must exit non-zero AND match
assert_fails_with() {
  local desc="$1" dir="$2" pat="$3"; shift 3
  local out; out=$(docker exec "$AGENT" sh -c "cd '$dir' 2>/dev/null && $CLI $* ; echo __RC=\$?" 2>&1)
  local rc="${out##*__RC=}"; rc="${rc%%$'\n'*}"
  if [ "$rc" != "0" ] && echo "$out" | grep -qE "$pat"; then ok "$desc"; else fail "$desc (rc=$rc, want non-zero + /$pat/)"; fi
}

# --- discover a real copy + a running live-dev deployment ------------------
COPY=$(docker exec "$AGENT" sh -c 'ls -1 /workspace/copies/ 2>/dev/null | head -1')
[ -n "$COPY" ] || { echo "No copy under /workspace/copies in $AGENT; cannot test."; exit 2; }
COPY_DIR="/workspace/copies/$COPY"
# a BP subdir inside the copy (copy-detection must also work from deeper paths)
BP=$(docker exec "$AGENT" sh -c "ls -1 '$COPY_DIR' 2>/dev/null | grep -vE '^\\.' | head -1")
BP_DIR="$COPY_DIR${BP:+/$BP}"
echo "Using copy: $COPY  (BP dir: $BP_DIR)"

log "root / help"
assert_ok       "top-level --help"                 "/" "--help"
assert_contains "help lists deployments+requirements" "/" "deployments" "--help"

log "#247 REGRESSION GUARD — copy auto-detect against the REAL /workspace/copies layout"
# From the copy root, with NO --copy flag: auto-detect must succeed (this is the
# exact command that failed in #247 when the path prefix was stale).
assert_ok       "deployments list auto-detects copy from copy root" "$COPY_DIR" "deployments list"
# From a BP subdir (deeper path): detection must still resolve the copy.
assert_ok       "deployments list auto-detects copy from BP subdir" "$BP_DIR"   "deployments list"
# From a NON-copy dir it must FAIL with a clear /workspace/copies/ message
# (never the stale 'worktrees' path, and never a silent wrong result).
assert_fails_with "clear error outside a copy dir" "/home/agent" "copies" "deployments list"

log "deployments (explicit --copy)"
assert_contains "deployments list --copy shows the header" "$COPY_DIR" "DEPLOYMENT_ID" "deployments list --copy $COPY"

# find a RUNNING deployment id to exercise the per-deployment subcommands
RUN=$(docker exec "$AGENT" sh -c "cd '$COPY_DIR' && $CLI deployments list --copy $COPY 2>/dev/null" | awk '$2=="running"{print $1; exit}')
if [ -n "$RUN" ]; then
  echo "Running deployment under test: $RUN"
  assert_contains "deployments inspect"     "$COPY_DIR" "container_id|container_name" "deployments inspect $RUN"
  assert_contains "deployments inspect-env" "$COPY_DIR" "BITSWAN_DEPLOYMENT_ID"       "deployments inspect-env $RUN"
  assert_ok       "deployments logs -n 3"   "$COPY_DIR" "deployments logs $RUN -n 3"
  assert_contains "deployments exec echoes"  "$COPY_DIR" "cli-e2e-probe" "deployments exec $RUN -- echo cli-e2e-probe"
  assert_ok       "deployments restart"     "$COPY_DIR" "deployments restart $RUN"
else
  fail "no RUNNING deployment found to exercise inspect/logs/exec/restart (start one in bringup)"
fi

log "requirements (in a BP dir)"
assert_ok       "requirements list"            "$BP_DIR" "requirements list"
# additive mutation round-trip, then clean up
REQ_TXT="cli-e2e probe $(docker exec "$AGENT" sh -c 'date +%s')"
ADD_OUT=$(docker exec "$AGENT" sh -c "cd '$BP_DIR' && $CLI requirements add --text '$REQ_TXT' --status proposed 2>&1")
if echo "$ADD_OUT" | grep -qE 'AI-|REQ-|added|proposed'; then
  ok "requirements add"
  NEWID=$(echo "$ADD_OUT" | grep -oE '(AI|REQ)-[0-9]+' | head -1)
  assert_contains "requirements list shows the new req" "$BP_DIR" "${NEWID:-cli-e2e}" "requirements list"
  [ -n "$NEWID" ] && assert_ok "requirements update status" "$BP_DIR" "requirements update --id $NEWID --status pending"
  # clean up the probe requirement so we don't leave state behind
  [ -n "$NEWID" ] && docker exec "$AGENT" sh -c "cd '$BP_DIR' && $CLI requirements remove --id $NEWID >/dev/null 2>&1"
else
  fail "requirements add ($(echo "$ADD_OUT" | head -1))"
fi

log "deployments start (write path — deploys a not-yet-started live-dev)"
NOTDEP=$(docker exec "$AGENT" sh -c "cd '$COPY_DIR' && $CLI deployments list --copy $COPY 2>/dev/null" | grep 'not deployed' | head -1 | awk '{print $1}')
if [ -n "$NOTDEP" ]; then
  # A fresh start prints "started (task: …)"; a re-run against an
  # already-starting deployment returns 409 "already in progress". Both prove
  # the start endpoint/contract works (this is the guard). The real #247 bug —
  # the CLI sending deployment_id instead of relative_path — surfaces as a 422
  # "Field required" that matches NEITHER, so it still fails the assertion.
  assert_contains "deployments start (task or already-in-progress)" "$COPY_DIR" \
    "started|task|already in progress|already running|already deployed" \
    "deployments start $NOTDEP --copy $COPY"
else
  echo "   (every automation already deployed — no 'not deployed' target for start)"
fi

log "deployments build-and-restart (write path — rebuilds the image via the driver)"
if [ -n "${RUN:-}" ]; then
  assert_ok "deployments build-and-restart" "$COPY_DIR" "deployments build-and-restart $RUN"
else
  fail "no running deployment for build-and-restart"
fi

log "requirements next / json / test"
assert_ok       "requirements next"          "$BP_DIR" "requirements next"
assert_contains "requirements json is JSON"  "$BP_DIR" '\[|\{' "requirements json"
# `requirements test` must actually EXECUTE a test run inside the BP's live-dev
# container. Run it against the BP that owns the RUNNING deployment, pinned with
# --deployment so it never falls back to auto-detect. A pass/fail result or
# "no requirements" is fine — the guard is that the command reaches execution.
# Only a hard contract/transport/crash counts as failure (NOT cobra's benign
# "Usage:" banner, which it prints on every handled error).
if [ -n "${RUN:-}" ]; then
  RUN_BP="${RUN#*-copy-${COPY}-}"; RUN_BP="${RUN_BP%-live-dev}"
  RUN_BP_DIR="/workspace/copies/$COPY/$RUN_BP"
  docker exec "$AGENT" sh -c "[ -d '$RUN_BP_DIR' ]" || RUN_BP_DIR="$BP_DIR"
  TOUT=$(docker exec "$AGENT" sh -c "cd '$RUN_BP_DIR' && $CLI requirements test --deployment '$RUN' 2>&1")
  if echo "$TOUT" | grep -qiE 'unknown flag|API error \(HTTP 5|connection refused|no such file or directory|panic:|runtime error'; then
    fail "requirements test (contract/transport error: $(echo "$TOUT" | grep -iE 'error|panic' | head -1))"
  else
    ok "requirements test executes (against $RUN_BP)"
  fi
else
  fail "no running deployment to pin requirements test against"
fi

# --- summary ---------------------------------------------------------------
log "SUMMARY"
echo "   passed: $PASS   failed: $FAILED"
[ "$FAILED" -eq 0 ] || { echo "CLI E2E FAILED"; exit 1; }
echo "CLI E2E PASSED"
