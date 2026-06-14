"""Minimal FastAPI worker.

A private backend reached by the business process's frontend over the Docker
network: the frontend shim proxies `/api/*` here with the `/api` prefix
stripped, so a frontend request to `/api/hello` arrives as `/hello`.

This is deliberately the smallest useful starting point — one health endpoint
and one greeting. Add routers, models, and infra dependencies (Postgres/MinIO
via `[services.*]` in automation.toml) as the workload grows. Because it's
Python-native, it's a good base for ML / data workloads.
"""

from fastapi import FastAPI

app = FastAPI(title="FastAPI worker")


@app.get("/")
def health() -> dict[str, str]:
    """Liveness probe."""
    return {"status": "ok"}


@app.get("/hello")
def hello() -> dict[str, str]:
    """Example endpoint — replace with the worker's real API."""
    return {"message": "Hello from the FastAPI worker"}
