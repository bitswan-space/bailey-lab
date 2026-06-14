#!/bin/sh
set -e

export VITE_BITSWAN_WORKSPACE_NAME="${BITSWAN_WORKSPACE_NAME}"
export VITE_BITSWAN_DEPLOYMENT_ID="${BITSWAN_DEPLOYMENT_ID}"
export VITE_BITSWAN_AUTOMATION_STAGE="${BITSWAN_AUTOMATION_STAGE}"
export VITE_BITSWAN_GITOPS_DOMAIN="${BITSWAN_GITOPS_DOMAIN}"
export VITE_PORT=5173
export PORT=8080

cp /app/vite.config.mjs /deps/vite.config.mjs
cd /app

# Use the project's installed vite (pinned in package.json, installed into
# /deps at image build), NOT `npx vite`. When npx can't resolve the local vite
# through the bind-mounted /app/node_modules → /deps symlink it silently
# fetches the latest vite from the registry, and that newer major fails to
# resolve `react` during the production build.
VITE=/deps/node_modules/.bin/vite

if [ "$BITSWAN_AUTOMATION_STAGE" = "live-dev" ]; then
  echo "Frontend: vite (hot reload) on :5173 + shim on :8080"
  "$VITE" --config /deps/vite.config.mjs --host 127.0.0.1 --port 5173 &
else
  echo "Frontend: building production bundle, serving on :5173 + shim on :8080"
  "$VITE" build --config /deps/vite.config.mjs --outDir /tmp/dist --emptyOutDir
  serve -s /tmp/dist -l 5173 &
fi

# The shim is the container's entrypoint process (PID-ish): it owns :8080,
# proxies / → vite/serve on :5173 and /api → the backend worker.
exec shim
