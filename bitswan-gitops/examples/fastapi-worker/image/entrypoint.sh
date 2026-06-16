#!/bin/sh
set -e

cd /app

PORT="${PORT:-8080}"

# Live dev mode: reload on source changes. The source tree is mounted
# read-only, which is fine — uvicorn's reloader only reads it.
if [ "$BITSWAN_AUTOMATION_STAGE" = "live-dev" ]; then
  echo "Starting FastAPI worker in live-dev mode (auto-reload) on :$PORT..."
  exec uvicorn main:app --host 0.0.0.0 --port "$PORT" --reload
fi

# Production mode: run without the reloader.
echo "Starting FastAPI worker on :$PORT..."
exec uvicorn main:app --host 0.0.0.0 --port "$PORT"
