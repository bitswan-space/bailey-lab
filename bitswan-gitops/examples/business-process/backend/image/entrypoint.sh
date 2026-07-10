#!/bin/sh
set -e

cd /app

# Live dev mode: watch for file changes and auto-rebuild using Air.
if [ "$BITSWAN_AUTOMATION_STAGE" = "live-dev" ]; then
  echo "Starting in live-dev mode with auto-rebuild (Air)..."
  exec air -c /etc/air.toml
fi

# Production mode: run the binary compiled ONCE at image-build time by build.sh
# (the driver runs it as a final RUN layer during the deploy image bake), so
# startup is instant — no per-startup `go build`. If it's missing the image was
# built without build.sh; fail loudly rather than silently rebuilding.
if [ ! -x /app/server ]; then
  echo "ERROR: /app/server not found — build.sh must run at image-build time" >&2
  exit 1
fi
echo "Starting server..."
exec /app/server
