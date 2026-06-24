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

# The binary will be mounted at runtime
# Just create a placeholder to ensure the directory exists
RUN mkdir -p /usr/local/bin

# oauth2-proxy: the infra-driver's reconcile docker-cp's this binary into every
# oauth2-enabled container (gitops used to do this; the driver owns it now), so
# the runtime image — which the driver sidecar runs — must ship it. Same pinned
# build as the gitops image. Pin the version so cold builds don't depend on the
# rate-limited GitHub "latest release" API.
ARG OAUTH2_PROXY_VERSION=v2026.03.09.5
RUN curl -fL -o /usr/local/bin/oauth2-proxy \
      "https://github.com/bitswan-space/bitswan-aoc-oauth2/releases/download/${OAUTH2_PROXY_VERSION}/oauth2-proxy-mqtt" \
    && chmod +x /usr/local/bin/oauth2-proxy

# Default command (will be overridden at runtime)
CMD ["/usr/local/bin/bitswan", "automation-server-daemon", "__run"]

