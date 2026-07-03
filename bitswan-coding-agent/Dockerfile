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

# Copy session wrapper script
COPY agent-session-wrapper /usr/local/bin/agent-session-wrapper
RUN chmod +x /usr/local/bin/agent-session-wrapper

# Copy entrypoint
COPY entrypoint-agent.sh /usr/local/bin/entrypoint-agent.sh
RUN chmod +x /usr/local/bin/entrypoint-agent.sh

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/entrypoint-agent.sh"]
