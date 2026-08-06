FROM debian:stable

# Install all required tools
RUN set -e && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        mkcert \
        openssh-client \
        build-essential \
        libssl-dev \
        libcurl4-openssl-dev \
        libexpat1-dev \
        gettext \
        zlib1g-dev \
        git
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin

# syft: the driver runs it (it owns docker) to produce an image SBOM for the
# supply-chain panel, returning only the SBOM — gitops has no docker socket
# after the cut-over, so it can't scan the local image itself. grype stays in
# gitops (it scans the SBOM, which needs no docker).
RUN curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh \
        | sh -s -- -b /usr/local/bin

# restic: the daemon makes the nightly server-level backups (whole workspace
# trees + DB dumps) through the AOC restic REST proxy. From upstream releases:
# the proxy auth uses RESTIC_REST_USERNAME/PASSWORD, which needs
# restic >= 0.16 (Debian ships older).
RUN apt-get install -y --no-install-recommends bzip2 && \
    ARCH=$(dpkg --print-architecture) && \
    curl -fsSL -o /tmp/restic.bz2 "https://github.com/restic/restic/releases/download/v0.17.3/restic_0.17.3_linux_${ARCH}.bz2" && \
    bunzip2 /tmp/restic.bz2 && \
    install -m 755 /tmp/restic /usr/local/bin/restic && \
    rm -f /tmp/restic

# The binary will be mounted at runtime
# Just create a placeholder to ensure the directory exists
RUN mkdir -p /usr/local/bin

# Default command (will be overridden at runtime)
CMD ["/usr/local/bin/bitswan", "automation-server-daemon", "__run"]

