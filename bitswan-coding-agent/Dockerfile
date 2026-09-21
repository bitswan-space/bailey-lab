# Stage 1: Build the bitswan-coding-agent Go binary
FROM golang:1.24-bookworm AS builder

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod tidy && go mod download

COPY . .
RUN go mod tidy && CGO_ENABLED=0 go build -ldflags="-s -w" -o /bitswan-coding-agent .

# Stage 2: Runtime image
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y \
    openssh-server \
    curl \
    wget \
    git \
    python3 \
    python3-pip \
    python3-venv \
    jq \
    dtach \
    vim \
    gnupg \
    && mkdir -p /run/sshd \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Playwright MCP server + headless Chromium (#210), so Claude Code drives a
# browser through first-class tools (browser_navigate, browser_console_messages,
# browser_take_screenshot, …) instead of writing scripts against a library.
#
# The browser is installed with the MCP's own install-browser command, not a
# standalone `playwright install`: the MCP package pins its own playwright and
# wants the chrome-for-testing distribution, and a standalone install lands
# browsers at revisions the server refuses to use.
#
# One browser serves both access paths — the MCP server, and ad-hoc scripts that
# require('playwright') through NODE_PATH (CommonJS only; the ESM loader ignores
# NODE_PATH) and must launch with { channel: 'chromium' } to find
# chrome-for-testing. Browsers go to a world-readable shared path because this
# step runs as root while sessions run as the agent user, and the ENVs are
# re-exported in /etc/profile.d by the entrypoint because SSH sessions inherit
# none of this image's environment.
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules:/usr/lib/node_modules
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
    && playwright-mcp install-browser --with-deps chrome-for-testing \
    && chmod -R a+rX /opt/ms-playwright \
    && rm -rf /var/lib/apt/lists/*

# Create agent user
RUN useradd -m -s /bin/bash -u 1000 agent \
    && mkdir -p /home/agent/.ssh \
    && chown -R agent:agent /home/agent

# Claude Code CLI — installed at RUNTIME, not baked into this image.
#
# The CLI is Anthropic's proprietary software ("© Anthropic PBC. All rights
# reserved."), and ~208 MB of the package is one prebuilt native executable.
# Baking it in would redistribute that binary inside every published
# bitswan/coding-agent image. entrypoint-agent.sh installs it on first start
# instead, so nothing third-party ships in this image.
#
# Two prefixes, both writable by the runtime user — Claude Code's updater runs
# `npm -g config get prefix` and checks that directory for write permission; a
# plain `npm install -g` puts it in the root-owned /usr prefix, so every session
# the agent user gets the "Auto-update failed" banner (issue #269):
#   * CLAUDE_CODE_PREFIX (/home/agent/.npm-global) — where entrypoint-agent.sh
#     installs. /home/agent is a persistent volume (see
#     internal/services/coding_agent.go), so the download happens once per
#     workspace and survives container restarts *and* recreation.
#   * CLAUDE_CODE_BUNDLED_PREFIX (/opt/claude-code) — no longer populated at
#     build time, but kept on PATH as a fallback slot so an operator can still
#     pre-seed an image (air-gapped installs) without touching the entrypoint.
# PATH prefers the runtime-installed copy and falls back to the bundled slot.
#
# CLAUDE_CODE_VERSION is a hard pin, not a floor: the dashboard's VS Code
# extension host is coupled to a specific Claude Code build, so the CLI and the
# extension must move together. entrypoint-agent.sh sets DISABLE_AUTOUPDATER so
# the CLI cannot walk away from that pin on its own. Keep this in lockstep with
# the repo-root CLAUDE_CODE_VERSION file and the workspace-dashboard image —
# internal/services/claude_code_version_test.go fails if they drift.
ENV CLAUDE_CODE_PREFIX=/home/agent/.npm-global
ENV CLAUDE_CODE_BUNDLED_PREFIX=/opt/claude-code
ENV PATH="${CLAUDE_CODE_PREFIX}/bin:${CLAUDE_CODE_BUNDLED_PREFIX}/bin:${PATH}"
ARG CLAUDE_CODE_VERSION=2.1.268
ENV CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}

# sshd sessions do not inherit this image's env: login shells get PATH from
# /etc/profile (which overwrites it) plus /etc/profile.d/bitswan-agent.sh,
# written by the entrypoint; non-login `ssh <host> <command>` sessions get it
# from /etc/environment via pam_env. Cover the latter here.
RUN printf 'PATH="%s"\n' "$PATH" > /etc/environment

# Copy bitswan-coding-agent binary from builder
COPY --from=builder /bitswan-coding-agent /usr/local/bin/bitswan-coding-agent

# SSH configuration. Key-only auth: the dashboard (the container's only SSH
# client) authenticates with the workspace keypair installed by the entrypoint.
RUN sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && echo "AllowUsers agent" >> /etc/ssh/sshd_config \
    && echo "AcceptEnv SSH_USER_EMAIL SSH_WORKTREE SSH_BP SSH_CLAUDE_SESSION_ID SSH_AUTO_CMD" >> /etc/ssh/sshd_config \
    && echo "ForceCommand /usr/local/bin/agent-session-wrapper" >> /etc/ssh/sshd_config

# Create workspace directories
RUN mkdir -p /workspace/copies /var/log/agent-sessions \
    && chown -R agent:agent /workspace /var/log/agent-sessions

# Standing agent guidance. Sessions run with cwd /workspace/copies/<copy>/<bp>
# and Claude reads CLAUDE.md from every ancestor directory, so this one file
# reaches every session in every copy — always current with the image, never
# copied into (or drifting inside) user working trees. Teams can layer their
# own CLAUDE.md at the copy or BP level; Claude merges all levels.
COPY CLAUDE.md /workspace/CLAUDE.md

# Default per-copy .mcp.json — the entrypoint and the session wrapper seed it
# into copies that have none, as a bootstrap the user owns and may extend with
# their own MCP servers. Claude Code's managed-mcp.json is deliberately NOT used:
# it takes exclusive control and would block user-added servers. A bind mount
# over this file (the pre-existing operator hook) still wins.
COPY mcp.default.json /etc/bitswan/mcp.json

# Copy session wrapper script
COPY agent-session-wrapper /usr/local/bin/agent-session-wrapper
COPY seed-copy-mcp /usr/local/bin/seed-copy-mcp
RUN chmod +x /usr/local/bin/agent-session-wrapper /usr/local/bin/seed-copy-mcp

# Copy entrypoint
COPY entrypoint-agent.sh /usr/local/bin/entrypoint-agent.sh
RUN chmod +x /usr/local/bin/entrypoint-agent.sh

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/entrypoint-agent.sh"]
