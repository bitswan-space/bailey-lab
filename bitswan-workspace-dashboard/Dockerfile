# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS builder
WORKDIR /build

COPY package.json package-lock.json* ./
COPY client/package.json client/
COPY server/package.json server/
RUN --mount=type=cache,target=/root/.npm \
    npm install --include=dev

COPY tsconfig.base.json ./
COPY client/ client/
COPY server/ server/

RUN npm run build

RUN npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# openssh-client is needed by the coding-agent terminal — the dashboard
# server shells out to `ssh agent@${WS}-coding-agent` to open agent sessions.
# ca-certificates ships the system CA bundle and `update-ca-certificates`,
# which the entrypoint runs at startup so any custom CAs mounted into
# /usr/local/share/ca-certificates/custom are trusted when the dashboard server
# connects to Keycloak/gitops over TLS signed by a private CA (mkcert / corporate
# root). (The pty binding ships prebuilds via @homebridge/node-pty-prebuilt-
# multiarch, so dev-mode `npm install` no longer needs a C toolchain at runtime.)
# curl + unzip are for the Claude Code extension fetch in entrypoint.sh. This
# image otherwise has no HTTP client and no zip reader (GNU tar cannot open a
# .vsix), and the extension is a zip served over HTTPS.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*

RUN userdel -r node 2>/dev/null || true \
 && groupdel node 2>/dev/null || true \
 && groupadd -g 1000 coder \
 && useradd -u 1000 -g 1000 -m -s /bin/bash coder \
 && mkdir -p /workspace/workspace \
 && chown -R coder:coder /workspace

COPY --from=builder --chown=coder:coder /build/package.json ./
COPY --from=builder --chown=coder:coder /build/server/package.json ./server/
COPY --from=builder --chown=coder:coder /build/client/package.json ./client/
COPY --from=builder --chown=coder:coder /build/server/dist ./server/dist
COPY --from=builder --chown=coder:coder /build/client/dist ./client/dist
COPY --from=builder --chown=coder:coder /build/node_modules ./node_modules

COPY --chown=coder:coder entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# claudeProcessWrapper for the Claude Code extension: a stdio proxy that runs
# `claude` in the coding-agent container rather than this one. See the script's
# own header for why. openssh-client above is what it needs.
COPY --chown=coder:coder claude-process-wrapper /usr/local/bin/claude-process-wrapper
RUN chmod +x /usr/local/bin/claude-process-wrapper

# Entrypoint starts as root so it can refresh the CA bundle when the daemon
# mounts custom CAs (via UPDATE_CA_CERTIFICATES=true), then drops to `coder`
# via `runuser` before launching the dashboard. Without this the dashboard
# server can't verify Keycloak/gitops certs signed by a private CA (mkcert /
# corporate root). Auth is enforced upstream by the Bailey gate — the dashboard
# itself runs no oauth2-proxy.
ENV NODE_ENV=production
ENV PORT=8080

# The Claude Code VS Code extension is downloaded at runtime by entrypoint.sh
# rather than baked in: it is Anthropic's proprietary software and ~208 MB of
# the 218 MB unpacked is one prebuilt native binary, so shipping it inside a
# published bitswan/workspace-dashboard image would redistribute it.
#
# A hard pin, not a floor. The vscode-host shim reads the extension's own
# compiled artifacts — it regexes a minifier-generated identifier out of the
# webview bundle (services/vscode-sidebar.ts:seedAssetUris) and derives its
# theme variables from the bundle's stylesheet (themeBlock) — so a different
# extension build can break the panel silently. The CLI in the coding-agent
# image is pinned to the same version so the two halves cannot drift; keep this
# in lockstep with the repo-root CLAUDE_CODE_VERSION file
# (internal/services/claude_code_version_test.go fails if they drift).
ARG CLAUDE_CODE_VERSION=2.1.268
ENV CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}

EXPOSE 8080

CMD ["/usr/local/bin/entrypoint.sh"]
