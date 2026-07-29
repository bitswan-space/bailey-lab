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
    tmux \
    dtach \
    vim \
    gnupg \
    && mkdir -p /run/sshd \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20.x
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install asciinema
RUN apt-get update && apt-get install -y asciinema && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
#
# The version is pinned via the CLAUDE_CODE_VERSION build arg so builds are
# reproducible and the installed version is visible in one place. To upgrade,
# bump the default below (find the latest with `npm view @anthropic-ai/claude-code version`).
# Changing this value also busts the Docker layer cache, so the new version is
# actually reinstalled on the next build. CI may override it with
# `--build-arg CLAUDE_CODE_VERSION=...`.
ARG CLAUDE_CODE_VERSION=2.1.197
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Playwright MCP server + headless Chromium (#210) so Claude Code can drive a
# browser through first-class MCP tools (browser_navigate,
# browser_console_messages, browser_take_screenshot, …) and diagnose frontend
# issues itself. Pinned like CLAUDE_CODE_VERSION above. The MCP package ships
# its own playwright dependency (an alpha by their release model) and wants
# the chrome-for-testing distribution, so the browser is installed with the
# MCP's own install-browser command — a standalone `playwright install` puts
# browsers at revisions the server refuses to use. One browser serves both
# access paths: the MCP server (seeded .mcp.json passes --browser chromium)
# and ad-hoc scripts, which require('playwright') via NODE_PATH (CommonJS
# only — the ESM loader ignores NODE_PATH) and must launch with
# { channel: 'chromium' } to target chrome-for-testing. Chromium needs
# --no-sandbox here (no user namespaces); wired into the seeded .mcp.json.
# Browsers go to a world-readable
# shared path: this build step runs as root, but sessions run as the agent
# user. These ENVs must also reach SSH sessions — entrypoint-agent.sh exports
# them in /etc/profile.d.
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    NODE_PATH=/usr/lib/node_modules/@playwright/mcp/node_modules:/usr/lib/node_modules
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} \
    && playwright-mcp install-browser --with-deps chrome-for-testing \
    && chmod -R a+rX /opt/ms-playwright \
    && rm -rf /var/lib/apt/lists/*

# Copy bitswan-coding-agent binary from builder
COPY --from=builder /bitswan-coding-agent /usr/local/bin/bitswan-coding-agent

# Create agent user
RUN useradd -m -s /bin/bash -u 1000 agent \
    && mkdir -p /home/agent/.ssh \
    && chown -R agent:agent /home/agent

# SSH configuration
RUN sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config \
    && sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
    && echo "AllowUsers agent" >> /etc/ssh/sshd_config \
    && echo "AcceptEnv SSH_USER_EMAIL SSH_LOGGED SSH_WORKTREE SSH_BP SSH_CLAUDE_SESSION_ID SSH_SESSION_KIND SSH_AUTO_CMD" >> /etc/ssh/sshd_config \
    && echo "ForceCommand /usr/local/bin/agent-session-wrapper" >> /etc/ssh/sshd_config

# Create workspace directories
RUN mkdir -p /workspace/copies /var/log/agent-sessions \
    && chown -R agent:agent /workspace /var/log/agent-sessions

# Default per-copy .mcp.json — entrypoint-agent.sh seeds it into copies that
# don't have one, as a user-ownable bootstrap they may extend with their own
# MCP servers. (Claude Code's managed-mcp.json is deliberately not used: it
# takes exclusive control and would block user-added servers.) A bind mount
# over the /etc/bitswan file — the pre-existing operator hook — still wins.
COPY mcp.default.json /etc/bitswan/mcp.json
# entrypoint-agent.sh copies this into any worktree that has no CLAUDE.md of
# its own. It is where the agent is told to reach apps through the public gate
# rather than by their internal address — the guidance the browsing identity
# depends on. A workspace that mounts its own /etc/bitswan/CLAUDE.md still
# shadows this default.
COPY CLAUDE.md /etc/bitswan/CLAUDE.md

# Copy session wrapper script
COPY agent-session-wrapper /usr/local/bin/agent-session-wrapper
COPY seed-copy-mcp /usr/local/bin/seed-copy-mcp
# Establishes the agent's authenticated browser session (#232) and saves it
# where the MCP server's --storage-state points. Node script: it needs
# playwright (via NODE_PATH) to drive the login, and the same crypto the
# daemon's TOTP seed was generated with.
COPY agent-browser-login /usr/local/bin/agent-browser-login
RUN chmod +x /usr/local/bin/agent-session-wrapper /usr/local/bin/seed-copy-mcp \
    /usr/local/bin/agent-browser-login

# Copy entrypoint
COPY entrypoint-agent.sh /usr/local/bin/entrypoint-agent.sh
RUN chmod +x /usr/local/bin/entrypoint-agent.sh

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/entrypoint-agent.sh"]
