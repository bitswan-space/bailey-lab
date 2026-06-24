# Build the Bitswan automation-server CLI from this monorepo's source, so the
# gitops image carries the EXACT in-repo version (not a downloaded upstream
# release). This makes integration tests exercise the automation-server changes
# in this same repo. Build context is the repo root (see .dockerignore).
FROM golang:1.25-bookworm AS bitswan-builder
WORKDIR /src
COPY bitswan-automation-server/go.mod bitswan-automation-server/go.sum ./
RUN go mod download
COPY bitswan-automation-server/ ./
RUN CGO_ENABLED=0 go build -ldflags "-w -s" -o /out/bitswan .

FROM python:3.11-bookworm
WORKDIR /src

ENV VERSION=27.3.1
RUN wget -qO- https://get.docker.com/ | sh

COPY bitswan-gitops/pyproject.toml .
COPY bitswan-gitops/LICENSE .
COPY bitswan-gitops/README.md .
COPY bitswan-gitops/app/ ./app/
# Bake the automation templates into the image so they are version-locked to
# this gitops build (no external examples repo to clone or mount).
COPY bitswan-gitops/examples/ /opt/bitswan/examples/
# Fast-forward-only hook installed into each workspace's canonical bare repo.
COPY bitswan-gitops/git-hooks/ /opt/bitswan/git-hooks/
COPY bitswan-gitops/start.sh .

RUN pip install -e .


# Create user 1000 and set up permissions
RUN useradd -u 1000 -m -s /bin/bash user1000
RUN chown -R user1000:user1000 /src

#switch to user 1000
USER user1000

RUN git config --global user.name "gitops"
RUN git config --global user.email "gitops@gitops.com"
RUN git config --global init.defaultBranch main

USER root

# Runtime tooling (snapshots/backups + the oauth2-proxy download below)
RUN apt-get update && apt-get install -y curl jq tar restic awscli && rm -rf /var/lib/apt/lists/*

# Supply-chain scanning: syft (SBOM) + grype (CVEs). Static Go binaries; grype
# downloads its vuln DB on first run (and the daily re-scan job refreshes it).
RUN curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh  | sh -s -- -b /usr/local/bin \
 && curl -sSfL https://raw.githubusercontent.com/anchore/grype/main/install.sh | sh -s -- -b /usr/local/bin

# Download oauth2-proxy. Pin the version via a build arg so the build does NOT
# depend on the unauthenticated GitHub "latest release" API at build time — that
# call is rate-limited to 60/hr/IP and makes cold builds flaky (jq chokes on the
# rate-limit body → exit 4). Override with --build-arg OAUTH2_PROXY_VERSION=…;
# leave it empty to fall back to querying latest.
ARG OAUTH2_PROXY_VERSION=v2026.03.09.5
RUN VERSION="$OAUTH2_PROXY_VERSION"; \
    if [ -z "$VERSION" ]; then \
      VERSION=$(curl -s https://api.github.com/repos/bitswan-space/bitswan-aoc-oauth2/releases/latest | jq -r '.tag_name'); \
    fi \
    && curl -fL -o /usr/local/bin/oauth2-proxy "https://github.com/bitswan-space/bitswan-aoc-oauth2/releases/download/${VERSION}/oauth2-proxy-mqtt" \
    && chmod +x /usr/local/bin/oauth2-proxy

# Bitswan Automation Server CLI, built from this repo's source (builder stage).
COPY --from=bitswan-builder /out/bitswan /usr/local/bin/bitswan
RUN chmod +x /usr/local/bin/bitswan

ENV BITSWAN_CADDY_HOST=http://caddy:2019

# Make startup script executable and move to system location
RUN chmod +x /src/start.sh && mv /src/start.sh /usr/local/bin/start.sh

EXPOSE 8079

CMD ["/usr/local/bin/start.sh"]
