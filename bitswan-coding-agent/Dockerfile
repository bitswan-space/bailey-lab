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

# Create agent user
RUN useradd -m -s /bin/bash -u 1000 agent \
    && mkdir -p /home/agent/.ssh \
    && chown -R agent:agent /home/agent

# Install Claude Code CLI
#
# Claude Code updates itself. Its updater runs `npm -g config get prefix` and
# checks that directory for write permission; a plain `npm install -g` puts it
# in the root-owned /usr prefix, so every session the agent user gets the
# "Auto-update failed" banner (issue #269).
#
# So there are two prefixes, both writable by the runtime user:
#   * CLAUDE_CODE_BUNDLED_PREFIX (below) — installed at build time so a fresh
#     container has a working `claude` immediately, with no network round trip.
#   * CLAUDE_CODE_PREFIX (/home/agent/.npm-global) — what entrypoint-agent.sh
#     configures as npm's global prefix, so self-updates land there. /home/agent
#     is a persistent volume (see internal/services/coding_agent.go), so an
#     update survives container restarts *and* recreation.
# PATH prefers the self-updated copy and falls back to the bundled one.
#
# The version below is only a floor: whatever is installed at build time gets
# superseded at runtime by Claude Code's own updater, so it does not need
# routine bumping. It stays pinned rather than `@latest` because this layer is
# cached — `@latest` would be resolved once and then silently frozen by the
# layer cache, which is worse than an honest pin. Override for a one-off build
# with `docker build --build-arg CLAUDE_CODE_VERSION=...`.
ENV CLAUDE_CODE_PREFIX=/home/agent/.npm-global
ENV CLAUDE_CODE_BUNDLED_PREFIX=/opt/claude-code
ENV PATH="${CLAUDE_CODE_PREFIX}/bin:${CLAUDE_CODE_BUNDLED_PREFIX}/bin:${PATH}"
ARG CLAUDE_CODE_VERSION=2.1.197
RUN npm install -g --prefix "${CLAUDE_CODE_BUNDLED_PREFIX}" \
        @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    && chown -R agent:agent "${CLAUDE_CODE_BUNDLED_PREFIX}"

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

# Copy session wrapper script
COPY agent-session-wrapper /usr/local/bin/agent-session-wrapper
RUN chmod +x /usr/local/bin/agent-session-wrapper

# Copy entrypoint
COPY entrypoint-agent.sh /usr/local/bin/entrypoint-agent.sh
RUN chmod +x /usr/local/bin/entrypoint-agent.sh

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/entrypoint-agent.sh"]
