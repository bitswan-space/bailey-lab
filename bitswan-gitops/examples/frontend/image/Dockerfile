# Frontend image. The Go shim (this image/shim) is built and baked in; it
# fronts vite (the React app, bind-mounted at /app and hot-reloaded in
# live-dev) on :8080 and proxies /api to the private backend worker.
FROM golang:1.22-alpine AS shim
WORKDIR /src
COPY shim/go.mod ./
COPY shim/main.go ./
RUN CGO_ENABLED=0 go build -o /shim .

FROM node:20-alpine
RUN npm install -g serve
# Deps installed once at build time into /deps; the bind-mounted source tree
# carries committed symlinks (package.json, node_modules) that resolve here.
WORKDIR /deps
COPY package.json ./
RUN npm install
COPY --from=shim /shim /usr/local/bin/shim
WORKDIR /app
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
