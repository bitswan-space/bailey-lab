#!/bin/bash

# Dev mode is EXPLICIT, never inferred.
#
# BITSWAN_GITOPS_DEV_SOURCE names the directory where a live bitswan-gitops
# checkout has been bind-mounted. Whoever creates that mount sets this variable
# in the same breath, so the mount and the declaration cannot drift apart:
#   - the daemon: `bitswan workspace update <ws> --gitops-dev-source-dir <path>`
#     (internal/dockercompose/dockercompose.go sets the volume + this var + DEBUG)
#   - a manual container: docker run -v <checkout>:/src:z \
#                                    -e BITSWAN_GITOPS_DEV_SOURCE=/src ...
#
# This USED to be auto-detected as "/src/pyproject.toml exists and mentions
# bitswan-gitops". That condition is ALWAYS true: the Dockerfile bakes
# pyproject.toml and app/ into /src in every image, and the package is named
# bitswan-gitops-server. So every container ever built — production included —
# silently flipped itself into DEBUG=true (uvicorn StatReload supervisor, debug
# log level, FastAPI(debug=True)) and re-ran `pip install -e /src` on every
# start. Beyond the overhead, a spurious reload opens an ECONNREFUSED window
# that races first-visit copy creation (see app/uvicorn.py). Do not reintroduce
# any inference from paths that exist in the image.
if [ -n "$BITSWAN_GITOPS_DEV_SOURCE" ]; then
    if [ ! -f "$BITSWAN_GITOPS_DEV_SOURCE/pyproject.toml" ]; then
        echo "FATAL: BITSWAN_GITOPS_DEV_SOURCE=$BITSWAN_GITOPS_DEV_SOURCE but no pyproject.toml there." >&2
        echo "       Dev mode was requested and the source mount is missing or wrong; refusing to start." >&2
        exit 1
    fi
    echo "========================================"
    echo "DEV MODE: gitops source declared at $BITSWAN_GITOPS_DEV_SOURCE"
    echo "Enabling DEBUG=true for hot-reload support"
    echo "========================================"
    export DEBUG=true
    # Reinstall from the mounted source so the running container matches it
    # (picks up packages added after the image was built).
    echo "Dev mode: reinstalling dependencies from mounted source..."
    pip install -e "$BITSWAN_GITOPS_DEV_SOURCE" --quiet
fi

# Function to get the group ID of the docker socket
get_docker_gid() {
    if [ -S /var/run/docker.sock ]; then
        # Get the group ID of the docker socket
        stat -c %g /var/run/docker.sock
    else
        # Fallback to docker group if socket doesn't exist
        getent group docker | cut -d: -f3
    fi
}

# Function to ensure user1000 is in the docker group
setup_docker_group() {
    local docker_gid=$(get_docker_gid)
    
    if [ -n "$docker_gid" ]; then
        echo "Docker socket group ID: $docker_gid"
        
        # Get the group name that owns the socket (if socket exists)
        local docker_group=""
        if [ -S /var/run/docker.sock ]; then
            docker_group=$(stat -c %G /var/run/docker.sock)
        fi
        
        # Check if a group with this GID already exists
        local existing_group=$(getent group $docker_gid | cut -d: -f1)
        
        if [ -n "$existing_group" ]; then
            # Use the existing group
            echo "Using existing group: $existing_group (GID: $docker_gid)"
            usermod -aG $existing_group user1000
        else
            groupdel docker 2>/dev/null || true
            # Create a new docker group with the socket's GID
            echo "Creating docker group with GID $docker_gid"
            groupadd -g $docker_gid docker 2>/dev/null || true
            usermod -aG docker user1000
        fi
    else
        echo "Warning: Could not determine docker group ID"
    fi
}

if [ "$UPDATE_CA_CERTIFICATES" = "true" ]; then
    echo "Updating CA certificates..."
    if [ -d /usr/local/share/ca-certificates/custom ]; then
        # Copy certificates from read-only mount to writable location
        cp /usr/local/share/ca-certificates/custom/*.crt /usr/local/share/ca-certificates/ 2>/dev/null || true
        cp /usr/local/share/ca-certificates/custom/*.pem /usr/local/share/ca-certificates/ 2>/dev/null || true
        
        # Rename .pem files to .crt (update-ca-certificates requires .crt)
        for f in /usr/local/share/ca-certificates/*.pem; do
            [ -f "$f" ] && mv "$f" "${f%.pem}.crt"
        done
        
        # Update the system CA certificates
        update-ca-certificates 2>&1 | grep -v "WARNING: ca-certificates.crt does not contain exactly one certificate or CRL"
        echo "CA certificates updated successfully"
    else
        echo "No custom CA certificates found at /usr/local/share/ca-certificates/custom"
    fi
fi

chown -R 1000 /gitops/gitops/

# Per-BP stage snapshots live on a dedicated bind mount (/gitops/snapshots,
# see dockercompose.go). Docker creates the mount point owned by root, but the
# gitops process runs as user1000 and must create per-BP snapshot dirs beneath
# it — otherwise snapshot/restore/clone fail with EACCES on /gitops/snapshots.
# Chown the mount point only (not -R): the tree can be large and everything
# under it is already created as user1000.
mkdir -p /gitops/snapshots
chown 1000 /gitops/snapshots

# Service secrets (postgres/garage env files) are written here
# by the gitops process when it auto-enables a BP's declared infra services.
# The host dir is created by the daemon as root and bind-mounted in, so the
# user1000 process can't write into it — auto-enable then fails with EACCES on
# /gitops/secrets and the backend never gets its DB. Recurse: the daemon may
# have pre-seeded root-owned files here.
mkdir -p /gitops/secrets
chown -R 1000 /gitops/secrets

# Supply-chain scan cache (SBOM + CVE json per image) lives at
# $BITSWAN_GITOPS_DIR/supply-chain (= /gitops/supply-chain). /gitops itself is
# root-owned, so the user1000 gitops process can't create this dir at scan time
# (os.makedirs → EACCES) — which silently leaves EVERY supply-chain/Checks scan
# stuck in "Scan pending" with no SBOM ever written. Pre-create it writable,
# mirroring snapshots/secrets above.
mkdir -p /gitops/supply-chain
chown -R 1000 /gitops/supply-chain

# Always set up Docker group permissions for user1000
# This ensures user1000 can access Docker socket even when running as root
setup_docker_group

# Main execution
if [ -z "$HOST_PATH" ] && [ -z "$HOST_HOME" ] && [ -z "$HOST_USER" ]; then
    mkdir -p /var/log/internal-image-build
    chown -R user1000:user1000 /var/log/internal-image-build
    chown -R user1000:user1000 /home/user1000

    # Setup SSH known_hosts for GitHub to avoid manual verification
    echo "Setting up SSH known_hosts for GitHub"
    mkdir -p /home/user1000/.ssh
    if [ ! -f /home/user1000/.ssh/known_hosts ] || ! grep -q "github.com" /home/user1000/.ssh/known_hosts; then
        ssh-keyscan -H github.com >> /home/user1000/.ssh/known_hosts 2>/dev/null
    fi
    chmod 700 /home/user1000/.ssh
    chmod 600 /home/user1000/.ssh/known_hosts 2>/dev/null || true
    chown -R user1000:user1000 /home/user1000/.ssh

    echo "Running as user1000"
    exec su -s /bin/bash user1000 -c "bitswan-gitops-server"
else
    echo "Environment variables set, running as root"
    exec bitswan-gitops-server
fi
