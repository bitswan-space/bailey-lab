#!/usr/bin/env bash
set -euo pipefail

# Claude Code VS Code extension, fetched at runtime into the volume the daemon
# mounts at /claude-extension-cache.
#
# Why runtime and not baked into the image: the extension is Anthropic's
# proprietary software and ~208 MB of the 218 MB unpacked is one prebuilt
# native binary, so baking it in would redistribute it inside every published
# bitswan/workspace-dashboard image. Downloading it here keeps the image free
# of third-party payload; the volume is persistent, so this costs one download
# per workspace rather than one per container start.
#
# Only ever touches /claude-extension-cache. When an operator supplies their own
# copy (BITSWAN_CLAUDE_EXTENSION_DIR, bind-mounted read-only at
# /claude-extension) or a dev tree provides one, the daemon does not create this
# directory and this function no-ops — so a hand-managed extension is never
# clobbered.
#
# Never fails the container. The dashboard is far more than the sidebar, and it
# restarts with `restart: always`; a registry blip must not turn that into a
# crash loop. The server stats the directory (sidebarEnabled in
# services/vscode-sidebar.ts), so a failed fetch surfaces as "sidebar
# unavailable" rather than a panel that 503s after claiming to be ready.
CLAUDE_EXTENSION_CACHE=/claude-extension-cache

fetch_claude_extension() {
    local version="${CLAUDE_CODE_VERSION:-}"
    local dir="$CLAUDE_EXTENSION_CACHE"

    [ -d "$dir" ] || return 0
    if [ -z "$version" ] || [ "$version" = "skip" ]; then
        echo "[entrypoint] Claude Code extension fetch skipped (CLAUDE_CODE_VERSION=${version:-unset})"
        return 0
    fi

    if [ -f "$dir/.version" ] && [ "$(cat "$dir/.version" 2>/dev/null)" = "$version" ] \
       && [ -f "$dir/extension/extension.js" ]; then
        echo "[entrypoint] Claude Code extension ${version} already present"
        return 0
    fi

    local target
    case "$(dpkg --print-architecture 2>/dev/null || echo amd64)" in
        arm64) target=linux-arm64 ;;
        *)     target=linux-x64 ;;
    esac

    local base="https://open-vsx.org/api/Anthropic/claude-code/${target}/${version}/file/Anthropic.claude-code-${version}@${target}"
    local staging="$dir/.staging"
    local vsix="$dir/.claude-code.vsix"

    echo "[entrypoint] Fetching Claude Code extension ${version} (${target}, ~98 MB)..."
    local ok=false attempt expected
    for attempt in 1 2 3; do
        rm -rf "$staging" "$vsix"
        mkdir -p "$staging"
        if curl -fsSL --retry 2 -o "$vsix" "${base}.vsix" \
           && expected=$(curl -fsSL "${base}.sha256" 2>/dev/null) \
           && [ -n "$expected" ] \
           && echo "${expected}  ${vsix}" | sha256sum -c - >/dev/null 2>&1 \
           && unzip -q "$vsix" -d "$staging" \
           && [ -f "$staging/extension/extension.js" ]; then
            ok=true
            break
        fi
        echo "[entrypoint] Extension fetch attempt ${attempt} failed; retrying in $((attempt * 5))s"
        sleep $((attempt * 5))
    done

    if ! $ok; then
        rm -rf "$staging" "$vsix"
        if [ -f "$dir/extension/extension.js" ]; then
            echo "[entrypoint] WARNING: could not fetch Claude Code extension ${version} —" \
                 "keeping the copy already on disk ($(cat "$dir/.version" 2>/dev/null || echo unknown))"
        else
            echo "[entrypoint] WARNING: could not fetch Claude Code extension ${version} —" \
                 "the Coding Agent tab will report unavailable until a restart succeeds"
        fi
        return 0
    fi

    # Swap in only once the tree is known-complete, and drop .version first so
    # an interruption here re-fetches rather than leaving a stale version label
    # on a half-replaced directory.
    rm -f "$dir/.version"
    rm -rf "$dir/extension.old"
    if [ -d "$dir/extension" ]; then
        mv "$dir/extension" "$dir/extension.old"
    fi
    mv "$staging/extension" "$dir/extension"
    printf '%s\n' "$version" > "$dir/.version"
    rm -rf "$dir/extension.old" "$staging" "$vsix"

    echo "[entrypoint] Claude Code extension ${version} ready"
}

# Take the execute bit off the CLI bundled inside the extension. Always.
#
# Claude Code must never run in this container. This one reaches the whole
# workspace — BITSWAN_DEPLOY_SECRET, the workspace SSH key, every user's Claude
# credentials under /claude-config, its own server bundle — and the agent
# executes model-chosen shell commands. It runs in the coding-agent container
# instead, reached through claude-process-wrapper: an unprivileged container
# that already holds git, bitswan-coding-agent and the gitops credentials, and
# that the dashboard is deliberately kept off the network of (see
# server/src/routes/coding-agent.ts).
#
# The vsix ships resources/native-binary/claude mode 0755 and unzip preserves
# it, so without this every dashboard container holds a runnable Claude Code
# that nothing is supposed to run. That is a standing invitation to undo the
# isolation by accident: one extension update that stops honouring
# claudeProcessWrapper, one future code path that spawns the resolved binary
# directly, and execution moves back in here with nobody noticing. Disarmed, any
# such path fails loudly with EACCES instead.
#
# Only the mode changes. Not one byte of Anthropic's bundle is touched, nothing
# is deleted or renamed, and the extension still resolves the path exactly as
# before — its resolver tests for existence, not executability, and the path is
# only ever passed to the wrapper as an argument, which the wrapper drops. The
# copy that actually runs, in the agent container, is installed and run
# unmodified.
#
# Reapplied on every start rather than only after a download, so an
# already-unpacked copy from an earlier image gets disarmed too.
disarm_bundled_claude() {
    local binary="$CLAUDE_EXTENSION_CACHE/extension/resources/native-binary/claude"
    [ -f "$binary" ] || return 0
    [ -x "$binary" ] || return 0

    if chmod a-x "$binary" 2>/dev/null; then
        echo "[entrypoint] bundled Claude Code disarmed (it only ever runs in the coding-agent container)"
    else
        # The server refuses to start a host while this is executable, so say
        # plainly what is about to break and why.
        echo "[entrypoint] ERROR: could not remove the execute bit from $binary —" \
             "the Coding Agent tab will refuse to start rather than run Claude Code here"
    fi
}

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
    fetch_claude_extension
    disarm_bundled_claude
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
