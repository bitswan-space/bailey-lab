# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS builder
WORKDIR /build

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Fetch the bitswan oauth2-proxy fork
RUN LATEST_VERSION="$(curl -fsSL https://api.github.com/repos/bitswan-space/bitswan-aoc-oauth2/releases/latest | jq -r '.tag_name')" \
 && curl -fsSL -o /tmp/oauth2-proxy "https://github.com/bitswan-space/bitswan-aoc-oauth2/releases/download/${LATEST_VERSION}/oauth2-proxy-mqtt" \
 && chmod +x /tmp/oauth2-proxy

COPY package.json package-lock.json* ./
COPY client/package.json client/
COPY server/package.json server/
RUN --mount=type=cache,target=/root/.npm \
    npm install --include=dev

COPY tsconfig.base.json ./
COPY client/ client/
COPY server/ server/

RUN npm run build

RUN npm prune --omit=dev


FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# openssh-client is needed by the coding-agent terminal — the dashboard
# server shells out to `ssh agent@${WS}-coding-agent` to open agent sessions.
# (The pty binding ships prebuilds via @homebridge/node-pty-prebuilt-multiarch,
# so dev-mode `npm install` no longer needs a C toolchain at runtime.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*

RUN userdel -r node 2>/dev/null || true \
 && groupdel node 2>/dev/null || true \
 && groupadd -g 1000 coder \
 && useradd -u 1000 -g 1000 -m -s /bin/bash coder \
 && mkdir -p /workspace/workspace \
 && chown -R coder:coder /workspace

COPY --from=builder /tmp/oauth2-proxy /usr/local/bin/oauth2-proxy

COPY --from=builder --chown=coder:coder /build/package.json ./
COPY --from=builder --chown=coder:coder /build/server/package.json ./server/
COPY --from=builder --chown=coder:coder /build/client/package.json ./client/
COPY --from=builder --chown=coder:coder /build/server/dist ./server/dist
COPY --from=builder --chown=coder:coder /build/client/dist ./client/dist
COPY --from=builder --chown=coder:coder /build/node_modules ./node_modules

COPY --chown=coder:coder entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER coder
ENV NODE_ENV=production
ENV PORT=8080
ENV INTERNAL_PORT=8081
EXPOSE 8080

CMD ["/usr/local/bin/entrypoint.sh"]
