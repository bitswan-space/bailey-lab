# bitswan-workspace-dashboard

Demo: a small Vite+React app with an xterm.js terminal, backed by a Fastify + node-pty server. The terminal drops into `/workspace/workspace` inside the container.

## Quick start (Docker)

```sh
cp .env.example .env
mkdir -p workspace-demo
echo hello > workspace-demo/marker.txt
sudo chown -R 1000:1000 workspace-demo   # the in-container user is uid 1000
docker compose up --build
```

Open http://localhost:8080 — a terminal should appear with a bash prompt rooted in `/workspace/workspace`.

## Quick start (local dev, no Docker)

```sh
npm install
npm run dev
```

Vite serves the client at http://localhost:5173 and proxies `/ws` to the Fastify server on `:8080`.

> Local dev spawns the pty as your host user in the host filesystem. Use Docker for the realistic uid-1000 / mounted-workspace setup.
