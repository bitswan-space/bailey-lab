#!/bin/bash

# Generate SSH host keys if missing
ssh-keygen -A 2>/dev/null

# Set up authorized keys from env var
mkdir -p /home/agent/.ssh
if [ -n "$EDITOR_SSH_PUBLIC_KEY" ]; then
    echo "$EDITOR_SSH_PUBLIC_KEY" > /home/agent/.ssh/authorized_keys
fi
chown -R agent:agent /home/agent/.ssh 2>/dev/null
chmod 700 /home/agent/.ssh
chmod 600 /home/agent/.ssh/authorized_keys 2>/dev/null

# Configure git for the agent user
su - agent -c 'git config --global user.name "BitSwan Coding Agent"'
su - agent -c 'git config --global user.email "agent@bitswan.local"'
su - agent -c 'git config --global --add safe.directory "*"'

# Configure git credentials so plain `git push/pull` to the workspace git
# server authenticates with the agent secret. BITSWAN_GIT_REMOTE is the BASE
# URL of the per-BP repos (each clone's origin is <base>/<bp>.git); git's
# "store" helper matches by host, so a single host-only line in
# ~/.git-credentials covers every per-BP repo served from that host.
if [ -n "$BITSWAN_GIT_REMOTE" ] && [ -n "$BITSWAN_GITOPS_AGENT_SECRET" ]; then
    su - agent -c 'git config --global credential.helper store'
    # Strip scheme (http:// or https://) and any path, leaving just HOST[:port].
    GIT_REMOTE_NOSCHEME="${BITSWAN_GIT_REMOTE#*://}"
    GIT_REMOTE_HOST="${GIT_REMOTE_NOSCHEME%%/*}"
    printf 'http://agent:%s@%s\n' "$BITSWAN_GITOPS_AGENT_SECRET" "$GIT_REMOTE_HOST" \
        > /home/agent/.git-credentials
    chown agent:agent /home/agent/.git-credentials
    chmod 600 /home/agent/.git-credentials
fi

# Copy CLAUDE.md to copies that don't have it yet
if [ -f /etc/bitswan/CLAUDE.md ]; then
    for wt in /workspace/copies/*/; do
        if [ -d "$wt" ] && [ ! -f "$wt/CLAUDE.md" ]; then
            cp /etc/bitswan/CLAUDE.md "$wt/CLAUDE.md"
            chown agent:agent "$wt/CLAUDE.md"
        fi
    done
fi

# Ensure correct permissions
chown -R agent:agent /home/agent
chown -R agent:agent /var/log/agent-sessions

# Export environment for the agent
export BITSWAN_AGENT_MODE=true

# Write environment variables to a file that SSH sessions can source
# SSH login shells don't inherit Docker container env vars
{
    echo "export BITSWAN_GITOPS_URL=\"$BITSWAN_GITOPS_URL\""
    echo "export BITSWAN_GITOPS_AGENT_SECRET=\"$BITSWAN_GITOPS_AGENT_SECRET\""
    echo "export BITSWAN_GIT_REMOTE=\"$BITSWAN_GIT_REMOTE\""
    echo "export BITSWAN_WORKSPACE_NAME=\"$BITSWAN_WORKSPACE_NAME\""
    echo "export BITSWAN_AGENT_MODE=true"
} > /etc/profile.d/bitswan-agent.sh
chmod 644 /etc/profile.d/bitswan-agent.sh

echo "BitSwan Coding Agent ready"

# Start SSH server in foreground
exec /usr/sbin/sshd -D -e
