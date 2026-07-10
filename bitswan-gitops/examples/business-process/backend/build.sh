#!/bin/sh
set -e
# Runs at IMAGE-BUILD time (deploy) via the driver's final RUN layer — NOT at
# container startup — so the deployed container runs an already-compiled binary
# and starts fast. live-dev never runs this: it uses Air to rebuild on change.
cd /app
CGO_ENABLED=0 go build -o /app/server .
