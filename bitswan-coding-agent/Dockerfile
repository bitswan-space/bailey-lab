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
    python3 \
    python3-pip \
    python3-venv \
    jq \
    tmux \
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
RUN npm install -g @anthropic-ai/claude-code

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
    && echo "AcceptEnv SSH_USER_EMAIL SSH_LOGGED SSH_WORKTREE" >> /etc/ssh/sshd_config \
    && echo "ForceCommand /usr/local/bin/agent-session-wrapper" >> /etc/ssh/sshd_config

# Create workspace directories
RUN mkdir -p /workspace/worktrees /var/log/agent-sessions \
    && chown -R agent:agent /workspace /var/log/agent-sessions

# Copy session wrapper script
COPY agent-session-wrapper /usr/local/bin/agent-session-wrapper
RUN chmod +x /usr/local/bin/agent-session-wrapper

COPY AGENTS-inside-container.md /AGENTS.md

# Copy entrypoint
COPY entrypoint-agent.sh /usr/local/bin/entrypoint-agent.sh
RUN chmod +x /usr/local/bin/entrypoint-agent.sh

EXPOSE 22

ENTRYPOINT ["/usr/local/bin/entrypoint-agent.sh"]
