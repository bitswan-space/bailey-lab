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
  # The deployed /app is read-only and the committed `node_modules -> /deps`
  # symlink isn't reliably materialized into the copy, so vite (root=/app) can't
  # find node_modules and fails to resolve bare imports (react/jsx-dev-runtime).
  # Provide node_modules at the container ROOT (writable): vite walks up from
  # /app and resolves via /node_modules -> /deps/node_modules. (The build branch
  # below does the equivalent under a writable /tmp copy.)
  ln -sfn /deps/node_modules /node_modules
  "$VITE" --config /deps/vite.config.mjs --host 127.0.0.1 --port 5173 &
else
  # The production bundle is built ONCE at image-build time by build.sh (the
  # driver runs it as a final RUN layer during the deploy image bake), so startup
  # just serves it — no per-startup vite build. If /app/dist is missing the image
  # was built without build.sh; fail loudly rather than silently rebuilding.
  echo "Frontend: serving pre-built bundle on :5173 + shim on :8080"
  if [ ! -d /app/dist ]; then
    echo "ERROR: /app/dist not found — build.sh must run at image-build time" >&2
    exit 1
  fi
  serve -s /app/dist -l 5173 &
fi

# The shim is the container's entrypoint process (PID-ish): it owns :8080,
# proxies / → vite/serve on :5173 and /api → the backend worker.
exec shim
