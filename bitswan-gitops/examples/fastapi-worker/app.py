"""Bitswan FastAPI worker.

A worker container is NOT exposed to the internet. It is reachable only on
the workspace's private Docker network, by frontends (via their shim) and by
other workers. The frontend proxies /api here and forwards the Bailey
identity headers, so this app can trust X-Forwarded-Email to identify the
caller without doing its own auth.

Peer workers are discovered explicitly via BITSWAN_WORKER_HOSTS, a
comma-separated list of `name=host:port` entries injected by gitops.
"""
import os

from fastapi import FastAPI, Request

app = FastAPI()


def worker_hosts() -> dict[str, str]:
    """Parse BITSWAN_WORKER_HOSTS into a {name: host:port} map."""
    out: dict[str, str] = {}
    for entry in os.environ.get("BITSWAN_WORKER_HOSTS", "").split(","):
        entry = entry.strip()
        if not entry or "=" not in entry:
            continue
        name, addr = entry.split("=", 1)
        out[name.strip()] = addr.strip()
    return out


@app.get("/api/hello")
def hello(request: Request) -> dict:
    # Bailey authenticates upstream; the frontend shim forwards the identity.
    user = request.headers.get("x-forwarded-email") or "anonymous"
    return {
        "msg": "hello from the backend worker",
        "you": user,
        "peers": list(worker_hosts()),
    }


@app.get("/api/health")
def health() -> dict:
    return {"status": "ok"}
