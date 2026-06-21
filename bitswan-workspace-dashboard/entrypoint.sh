#!/usr/bin/env bash
set -euo pipefail

# Root-only bootstrap: refresh the system CA bundle when the daemon mounted
# extra CAs (see internal/certauthority/mount.go in bitswan-automation-server
# — `trustCA=true` mounts ~/.config/bitswan/certauthorities into
# /usr/local/share/ca-certificates/custom and sets UPDATE_CA_CERTIFICATES=true).
# Without this the dashboard server can't verify Keycloak/gitops certs signed by
# a private CA — update-ca-certificates rebuilds /etc/ssl/certs/ca-certificates.crt
# and needs root.
if [ "$(id -u)" = "0" ]; then
    if [ "${UPDATE_CA_CERTIFICATES:-false}" = "true" ] \
       && [ -d /usr/local/share/ca-certificates/custom ]; then
        echo "[entrypoint] Updating CA certificates from /usr/local/share/ca-certificates/custom..."
        # Copy out of the read-only mount, normalise .pem → .crt (the only
        # extension update-ca-certificates indexes), then rebuild the bundle.
        cp /usr/local/share/ca-certificates/custom/*.crt /usr/local/share/ca-certificates/ 2>/dev/null || true
        cp /usr/local/share/ca-certificates/custom/*.pem /usr/local/share/ca-certificates/ 2>/dev/null || true
        for f in /usr/local/share/ca-certificates/*.pem; do
            [ -f "$f" ] || continue
            mv "$f" "${f%.pem}.crt"
        done
        update-ca-certificates 2>&1 \
          | grep -v "WARNING:.*exactly one certificate or CRL" \
          || true
    fi
    # Drop privileges and re-exec the same script as coder. `runuser` is in
    # util-linux (always present on Debian); -- and -p preserve env vars
    # like BITSWAN_DEV_MODE / PORT.
    exec runuser -u coder -- "$0" "$@"
fi

EXTERNAL_PORT="${PORT:-8080}"
DEV_BACKEND_PORT="${DEV_BACKEND_PORT:-8082}"

# Detect dev mode: a host source dir is mounted and BITSWAN_DEV_MODE is on.
DEV_MODE=false
if [ "${BITSWAN_DEV_MODE:-false}" = "true" ] \
   && [ -n "${BITSWAN_DASHBOARD_DEV_DIR:-}" ] \
   && [ -d "${BITSWAN_DASHBOARD_DEV_DIR}" ]; then
    DEV_MODE=true
fi

# The dashboard listens directly on EXTERNAL_PORT (all interfaces). Auth is
# enforced upstream by the Bailey gate — the dashboard runs no oauth2-proxy.
APP_LISTEN_PORT="${EXTERNAL_PORT}"
APP_LISTEN_HOST="0.0.0.0"

start_app() {
    if $DEV_MODE; then
        echo "[entrypoint] DEV MODE: running dashboard from ${BITSWAN_DASHBOARD_DEV_DIR}"
        cd "${BITSWAN_DASHBOARD_DEV_DIR}"

        # Vite + tsx watch are devDependencies; the production image sets
        # NODE_ENV=production which would skip them on `npm install`.
        unset NODE_ENV

        # Decide whether to install. Comparing package.json's mtime against
        # node_modules/ is unreliable: npm bumps the directory mtime *after*
        # package.json was last edited, so the next start sees node_modules
        # as "fresher" and skips install even when deps actually changed.
        # npm writes node_modules/.package-lock.json on every successful
        # install, so comparing it against the source lockfile is the right
        # signal.
        needs_install=true
        if [ -d node_modules ]; then
            if [ -f package-lock.json ] && [ -f node_modules/.package-lock.json ]; then
                if cmp -s package-lock.json node_modules/.package-lock.json; then
                    needs_install=false
                fi
            elif [ ! -f package-lock.json ] && [ ! package.json -nt node_modules ]; then
                needs_install=false
            fi
        fi

        if [ "$needs_install" = "true" ]; then
            echo "[entrypoint] Installing dashboard dev dependencies (this may take a minute)..."
            npm install --include=dev
        else
            echo "[entrypoint] Dependencies already in sync, skipping install."
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

echo "[entrypoint] dashboard on :${EXTERNAL_PORT} (auth enforced upstream by the Bailey gate)"
start_app
trap 'kill -TERM "${APP_PID}" 2>/dev/null || true' TERM INT
wait "${APP_PID}"
