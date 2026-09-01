#!/usr/bin/env bash
# Build workspace-service images locally as bitswan/<svc>-dev:latest for use with
# `bitswan workspace init --dev` (or `workspace update --dev`).
#
# Builds run in PARALLEL and the images are NEVER pushed — they live only on the
# local Docker daemon. `--dev` resolves each service to its -dev:latest tag (see
# internal/dockerhub/dockerhub.go), so build these first, then init/update a
# workspace with --dev.
#
# On failure the FULL build output of each failed image is printed and the log
# directory is kept, so a CI caller (or you) sees exactly what broke.
set -uo pipefail

SERVICES="gitops dashboard coding-agent egress-gateway infra-driver"

usage() {
	cat <<EOF
Build workspace-service images locally as bitswan/<svc>-dev:latest (parallel; never pushed).

Usage: ./build-dev-images.sh [--skip <svc>[,<svc>...]]...

Services: ${SERVICES}

  --skip <list>   Comma-separated service(s) to skip (repeatable), e.g. --skip dashboard
  -h, --help      Show this help

On failure, each failed image's full build log is printed and the log dir kept.
EOF
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AS="$REPO_ROOT/bitswan-automation-server"

# name | image tag | dockerfile | build context  (contexts mirror e2e/bringup.sh)
BUILDS=(
	"gitops|bitswan/gitops-dev:latest|$REPO_ROOT/bitswan-gitops/Dockerfile|$REPO_ROOT"
	"dashboard|bitswan/workspace-dashboard-dev:latest|$REPO_ROOT/bitswan-workspace-dashboard/Dockerfile|$REPO_ROOT/bitswan-workspace-dashboard"
	"coding-agent|bitswan/coding-agent-dev:latest|$REPO_ROOT/bitswan-coding-agent/Dockerfile|$REPO_ROOT/bitswan-coding-agent"
	"egress-gateway|bitswan/egress-gateway-dev:latest|$AS/cmd/egress-gateway/Dockerfile|$AS"
	"infra-driver|bitswan/infra-driver-dev:latest|$AS/cmd/infra-driver/Dockerfile|$AS"
)

declare -A SKIP
add_skips() { # comma-separated list -> validated SKIP entries
	IFS=',' read -ra parts <<<"$1"
	for p in "${parts[@]}"; do
		[ -n "$p" ] || continue
		case " $SERVICES " in
		*" $p "*) SKIP[$p]=1 ;;
		*) echo "error: unknown service in --skip: '$p' (known: $SERVICES)" >&2; exit 2 ;;
		esac
	done
}
while [ $# -gt 0 ]; do
	case "$1" in
	--skip)
		shift
		[ $# -gt 0 ] || { echo "error: --skip requires a value" >&2; exit 2; }
		add_skips "$1" ;;
	--skip=*)
		add_skips "${1#*=}" ;;
	-h | --help)
		usage
		exit 0 ;;
	*)
		echo "error: unknown argument: $1" >&2
		usage >&2
		exit 2 ;;
	esac
	shift
done

# Route the module/package fetches through the shared read-through proxies when
# the caller has them running (the E2E bring-up and a Bailey server both do).
# These images each start with `go mod download`, which otherwise goes straight
# to proxy.golang.org on every build — slow, and dead in the water when that
# proxy has a bad day. Opt-in: with the vars unset the array is empty and the
# build is exactly what it was, so a plain `./build-dev-images.sh` on a laptop
# is unchanged.
#
# The build needs to be ON the proxy network to resolve the container name, so
# BITSWAN_BUILD_NETWORK and BITSWAN_GOPROXY are set together or not at all.
PROXY_ARGS=()
if [ -n "${BITSWAN_GOPROXY:-}" ] && [ -n "${BITSWAN_BUILD_NETWORK:-}" ]; then
	PROXY_ARGS=(--network "$BITSWAN_BUILD_NETWORK" --build-arg "GOPROXY=$BITSWAN_GOPROXY")
	[ -n "${BITSWAN_NPM_REGISTRY:-}" ] && PROXY_ARGS+=(--build-arg "NPM_CONFIG_REGISTRY=$BITSWAN_NPM_REGISTRY")
	echo "Routing builds through $BITSWAN_GOPROXY on network $BITSWAN_BUILD_NETWORK"
fi

LOGDIR="$(mktemp -d)"
declare -A PIDS
ORDER=()
SKIPPED=()
for entry in "${BUILDS[@]}"; do
	IFS='|' read -r name tag dockerfile context <<<"$entry"
	if [ -n "${SKIP[$name]:-}" ]; then
		SKIPPED+=("$name")
		continue
	fi
	docker build "${PROXY_ARGS[@]}" -t "$tag" -f "$dockerfile" "$context" >"$LOGDIR/$name.log" 2>&1 &
	PIDS[$name]=$!
	ORDER+=("$name")
done

if [ "${#ORDER[@]}" -eq 0 ]; then
	echo "error: nothing to build — all services skipped." >&2
	rm -rf "$LOGDIR"
	exit 2
fi

[ "${#SKIPPED[@]}" -eq 0 ] || echo "Skipping: ${SKIPPED[*]}"
echo "Building ${#ORDER[@]} dev image(s) in parallel (logs in $LOGDIR)..."

fail=0
for name in "${ORDER[@]}"; do
	if wait "${PIDS[$name]}"; then
		echo "  ✓ $name"
	else
		echo "  ✗ $name — build FAILED. Full output below:" >&2
		echo "================ $name build log ================" >&2
		cat "$LOGDIR/$name.log" >&2
		echo "============== end $name build log ==============" >&2
		fail=1
	fi
done

if [ "$fail" -ne 0 ]; then
	echo "One or more dev images failed to build (logs kept in $LOGDIR)." >&2
	exit 1
fi

rm -rf "$LOGDIR"
echo "All requested dev images built (bitswan/<svc>-dev:latest)."
echo "Use them with: bitswan workspace init --dev   (or: bitswan workspace update --dev)"
