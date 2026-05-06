#!/usr/bin/env bash
set -euo pipefail

EXTERNAL_PORT="${PORT:-8080}"
INTERNAL_PORT="${INTERNAL_PORT:-8081}"
DEV_BACKEND_PORT="${DEV_BACKEND_PORT:-8082}"

# Detect dev mode: a host source dir is mounted and BITSWAN_DEV_MODE is on.
DEV_MODE=false
if [ "${BITSWAN_DEV_MODE:-false}" = "true" ] \
   && [ -n "${BITSWAN_DASHBOARD_DEV_DIR:-}" ] \
   && [ -d "${BITSWAN_DASHBOARD_DEV_DIR}" ]; then
    DEV_MODE=true
fi

# Where the user-facing app must end up listening:
#   - with OAuth: on INTERNAL_PORT (loopback) so oauth2-proxy fronts it on EXTERNAL_PORT
#   - without OAuth: directly on EXTERNAL_PORT (all interfaces)
if [ "${OAUTH_ENABLED:-false}" = "true" ]; then
    APP_LISTEN_PORT="${INTERNAL_PORT}"
    APP_LISTEN_HOST="127.0.0.1"
else
    APP_LISTEN_PORT="${EXTERNAL_PORT}"
    APP_LISTEN_HOST="0.0.0.0"
fi

start_app() {
    if $DEV_MODE; then
        echo "[entrypoint] DEV MODE: running dashboard from ${BITSWAN_DASHBOARD_DEV_DIR}"
        cd "${BITSWAN_DASHBOARD_DEV_DIR}"

        # Vite + tsx watch are devDependencies; the production image sets
        # NODE_ENV=production which would skip them on `npm install`.
        unset NODE_ENV

        if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then
            echo "[entrypoint] Installing dashboard dev dependencies (this may take a minute)..."
            npm install --include=dev
        fi

        # Vite dev server serves the SPA on APP_LISTEN_PORT and proxies /ws to
        # the tsx-watched backend on DEV_BACKEND_PORT (loopback).
        export VITE_HOST="${APP_LISTEN_HOST}"
        export VITE_PORT="${APP_LISTEN_PORT}"
        export VITE_BACKEND_URL="ws://127.0.0.1:${DEV_BACKEND_PORT}"
        export PORT="${DEV_BACKEND_PORT}"
        export HOST="127.0.0.1"

        # `npm run dev` at the repo root runs vite (client) + tsx watch (server)
        # in parallel via npm-run-all.
        npm run dev 2>&1 | sed -u 's/^/[dashboard-dev] /' &
    else
        PORT="${APP_LISTEN_PORT}" HOST="${APP_LISTEN_HOST}" \
            node /app/server/dist/index.js &
    fi
    APP_PID=$!
}

if [ "${OAUTH_ENABLED:-false}" = "true" ]; then
    echo "OAuth enabled: oauth2-proxy on :${EXTERNAL_PORT}, dashboard on :${INTERNAL_PORT}"

    export OAUTH2_PROXY_HTTP_ADDRESS="0.0.0.0:${EXTERNAL_PORT}"
    export OAUTH2_PROXY_UPSTREAMS="http://127.0.0.1:${INTERNAL_PORT}"
    : "${OAUTH2_PROXY_REVERSE_PROXY:=true}"
    : "${OAUTH2_PROXY_PASS_HOST_HEADER:=true}"
    : "${OAUTH2_PROXY_COOKIE_SECURE:=true}"
    # Cross-site iframe usage requires SameSite=None on the session cookie.
    : "${OAUTH2_PROXY_COOKIE_SAMESITE:=none}"
    # The SPA shell + assets must load unauthenticated so the in-page sign-in
    # flow can render. Protected routes (the websocket etc.) stay gated.
    : "${OAUTH2_PROXY_SKIP_AUTH_ROUTES:=^/$,^/index\\.html$,^/assets/,^/favicon\\.ico$,^/vite\\.svg$,^/@vite/,^/@react-refresh,^/@fs/,^/@id/,^/src/,^/node_modules/}"
    export OAUTH2_PROXY_REVERSE_PROXY OAUTH2_PROXY_PASS_HOST_HEADER \
           OAUTH2_PROXY_COOKIE_SECURE OAUTH2_PROXY_COOKIE_SAMESITE \
           OAUTH2_PROXY_SKIP_AUTH_ROUTES

    start_app

    oauth2-proxy &
    OAUTH_PID=$!

    trap 'kill -TERM "${APP_PID}" "${OAUTH_PID}" 2>/dev/null || true' TERM INT
    wait -n "${APP_PID}" "${OAUTH_PID}"
    EXIT_CODE=$?
    kill -TERM "${APP_PID}" "${OAUTH_PID}" 2>/dev/null || true
    wait || true
    exit "${EXIT_CODE}"
else
    echo "OAuth disabled: dashboard on :${EXTERNAL_PORT}"
    start_app
    trap 'kill -TERM "${APP_PID}" 2>/dev/null || true' TERM INT
    wait "${APP_PID}"
fi
