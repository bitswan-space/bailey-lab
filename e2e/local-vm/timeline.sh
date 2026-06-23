#!/usr/bin/env bash
# Lightweight cross-process step profiler for the E2E run.
#
# Source it, then call `mark "<what just finished>"` after each step. Each call
# appends a row to a timeline TSV and prints a live "+Xs (total Ys)" line, so the
# slow steps are obvious in run.log AND afterwards in the saved timeline.
#
# State (start time + previous checkpoint) lives in a file, NOT in env vars, so
# the timeline is continuous across the SEPARATE bash invocations of
# run-e2e.sh → bringup.sh (host run-qemu.sh keeps its own timeline file).
#
# Override TL_FILE / TL_STATE before sourcing to use a different timeline (the
# host runner does this so its phases don't collide with the guest's).

# Default the timeline under e2e/manual/build relative to THIS script, so it
# works both in the VM (repo at /repo) and in CI / any checkout (repo at
# $GITHUB_WORKSPACE) — a hardcoded /repo broke the dind e2e bring-up, whose
# checkout isn't at /repo. Callers may still override TL_FILE/TL_STATE.
_tl_self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TL_FILE="${TL_FILE:-$_tl_self/../manual/build/timeline.tsv}"
TL_STATE="${TL_STATE:-$_tl_self/../manual/build/.timeline-state}"

# Begin a fresh timeline. Call ONCE at the very start of the run.
tl_begin() {
  mkdir -p "$(dirname "$TL_FILE")" 2>/dev/null || true
  local now; now=$(date +%s.%N)
  printf 'when_utc\tseconds\ttotal_s\tstep\n' > "$TL_FILE"
  printf '%s %s\n' "$now" "$now" > "$TL_STATE"
  chmod 0666 "$TL_FILE" "$TL_STATE" 2>/dev/null || true
}

# Record the segment that just ended, labelled with what completed.
mark() {
  local label="$*"
  local now start prev dp ds
  now=$(date +%s.%N)
  if [ -f "$TL_STATE" ]; then
    read -r start prev < "$TL_STATE"
  else
    # No tl_begin — start the timeline here so a missing begin never aborts.
    start=$now; prev=$now
    printf 'when_utc\tseconds\ttotal_s\tstep\n' > "$TL_FILE" 2>/dev/null || true
  fi
  dp=$(awk "BEGIN{printf \"%.1f\", $now-$prev}")
  ds=$(awk "BEGIN{printf \"%.1f\", $now-$start}")
  printf '%s\t%s\t%s\t%s\n' "$(date -u +%H:%M:%S)" "$dp" "$ds" "$label" >> "$TL_FILE" 2>/dev/null || true
  printf '⏱  +%6ss  total %8ss  %s\n' "$dp" "$ds" "$label"
  printf '%s %s\n' "$start" "$now" > "$TL_STATE"
  chmod 0666 "$TL_FILE" "$TL_STATE" 2>/dev/null || true
}

# Print a slowest-first profile + the chronological timeline.
tl_profile() {
  [ -f "$TL_FILE" ] || return 0
  echo
  echo "=== STEP PROFILE — ${TL_FILE} (slowest first) ==="
  tail -n +2 "$TL_FILE" | sort -t"$(printf '\t')" -k2 -nr \
    | awk -F"$(printf '\t')" '{printf "  %8.1fs  %s\n", $2, $4}'
  echo "=== TIMELINE (chronological) ==="
  tail -n +2 "$TL_FILE" \
    | awk -F"$(printf '\t')" '{printf "  %s  +%8.1fs  (t=%8.1fs)  %s\n", $1, $2, $3, $4}'
}
