#!/usr/bin/env bash
#
# coverage-backend.sh — aggregate Go statement coverage across ONLY the new
# Bailey stage-2/3 daemon files.
#
# It runs `go test` over internal/daemon, then parses the coverage profile
# directly (file:startLine.col,endLine.col numStmts hitCount) so the aggregate
# is weighted by *statements*, not a naive average of per-function percentages.
#
# Output: a single number on stdout — the aggregate statement-coverage % over
# the new files — and a human-readable breakdown on stderr.
#
# Exit status mirrors `go test`. Pass FAIL_UNDER=<pct> to make the script exit
# non-zero when the aggregate is below that threshold (used by CI).

set -euo pipefail

# Resolve repo root (this script lives in <repo>/scripts/).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROFILE="${PROFILE:-$(mktemp /tmp/bailey-backend-cov.XXXXXX.out)}"
PKG="${PKG:-./internal/daemon/}"
FAIL_UNDER="${FAIL_UNDER:-}"

# The new stage-2/3 files. A profile line belongs to this set when its path
# matches one of these basenames (or basename prefixes for the families).
# Note: '.' is left unescaped intentionally (it matches a literal '.' too) so
# the pattern is portable across gawk/mawk without escape-sequence warnings.
NEW_FILE_RE='internal/daemon/(mfa_[^:]*|bailey_[^:]*|chrome_launcher.go|serverconsole.go|workspaces_baileyadmin.go|workspace_trash.go|acl_endpoints_page.go):'

# Test files are not part of the measured surface.
TEST_FILE_RE='_test.go:'

cd "${REPO_ROOT}"

echo "==> go test ${PKG} (coverprofile=${PROFILE})" >&2
go test "${PKG}" -coverprofile="${PROFILE}" -covermode=set -count=1 >&2

# Parse the profile: sum statements (col 2 of the trailing pair) and count as
# covered when hitCount (col 3) > 0, restricted to the new files.
AGG="$(awk -v newre="${NEW_FILE_RE}" -v testre="${TEST_FILE_RE}" '
  NR == 1 { next }                        # skip "mode:" header
  $0 ~ testre { next }                     # skip *_test.go
  $0 !~ newre { next }                     # only the new files
  {
    # Each data line: <loc> <numStmts> <hitCount>
    stmts = $(NF-1); hits = $NF;
    total += stmts;
    if (hits > 0) covered += stmts;
  }
  END {
    if (total == 0) { print "0.0 0 0"; exit }
    printf "%.1f %d %d\n", (covered * 100.0) / total, covered, total;
  }
' "${PROFILE}")"

PCT="$(echo "${AGG}" | cut -d' ' -f1)"
COVERED="$(echo "${AGG}" | cut -d' ' -f2)"
TOTAL="$(echo "${AGG}" | cut -d' ' -f3)"

echo "==> New-file aggregate: ${COVERED}/${TOTAL} statements = ${PCT}%" >&2

# The single machine-readable number on stdout.
echo "${PCT}"

if [[ -n "${FAIL_UNDER}" ]]; then
  # Integer-safe comparison via awk (PCT may be fractional).
  if awk -v p="${PCT}" -v t="${FAIL_UNDER}" 'BEGIN { exit !(p < t) }'; then
    echo "ERROR: backend new-file coverage ${PCT}% is below threshold ${FAIL_UNDER}%" >&2
    exit 1
  fi
fi
