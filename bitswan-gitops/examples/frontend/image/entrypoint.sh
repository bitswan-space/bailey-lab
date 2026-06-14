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

if [ "$BITSWAN_AUTOMATION_STAGE" = "live-dev" ]; then
  echo "Frontend: vite (hot reload) on :5173 + shim on :8080"
  npx vite --config /deps/vite.config.mjs --host 127.0.0.1 --port 5173 &
else
  echo "Frontend: building production bundle, serving on :5173 + shim on :8080"
  npx vite build --config /deps/vite.config.mjs --outDir /tmp/dist --emptyOutDir
  serve -s /tmp/dist -l 5173 &
fi

# The shim is the container's entrypoint process (PID-ish): it owns :8080,
# proxies / → vite/serve on :5173 and /api → the backend worker.
exec shim
