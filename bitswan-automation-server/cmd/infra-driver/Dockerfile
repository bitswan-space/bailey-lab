# Bitswan per-workspace infra-driver image — self-contained: the infra-driver
# binary baked in (NOT the bitswan CLI mounted from the host).
# Build context = the bitswan-automation-server repo root:
#   docker build -f cmd/infra-driver/Dockerfile -t bitswan/infra-driver:dev .
FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-w -s" -o /infra-driver ./cmd/infra-driver

FROM debian:stable
# Runtime tooling the driver shells out to: git (+ git-http-backend for the
# deploy repo's smart-HTTP), the docker CLI + compose plugin (it drives the host
# dockerd over the mounted socket: build/run/exec/cp/network + `compose up`), and
# curl/gnupg/ca-certificates for the Docker apt repo below.
RUN set -e && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        git && \
    rm -rf /var/lib/apt/lists/*
RUN install -m 0755 -d /etc/apt/keyrings && \
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg && \
    chmod a+r /etc/apt/keyrings/docker.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null && \
    apt-get update && \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin && \
    rm -rf /var/lib/apt/lists/*

# syft: the driver runs it (it owns docker) to produce an image SBOM for the
# supply-chain panel — gitops has no docker socket after the cut-over, so it
# can't scan the local image itself.
RUN curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh \
        | sh -s -- -b /usr/local/bin

COPY --from=build /infra-driver /usr/local/bin/infra-driver

# The daemon-generated compose `command` (buildDriverService) replaces this with
# the full `/usr/local/bin/infra-driver serve …` invocation. No ENTRYPOINT, so
# that command line runs as-is (mirrors the old runtime image). This default just
# keeps a bare `docker run` inspectable.
CMD ["/usr/local/bin/infra-driver", "--help"]
