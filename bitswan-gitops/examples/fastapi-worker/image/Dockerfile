FROM python:3.13-alpine

# Dependencies are baked into the image (content-addressed by the image/ tree
# hash, like the Go worker's go.mod). The application source is bind-mounted at
# /app read-only at runtime, so nothing is written back into the source tree.
WORKDIR /deps
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Test tooling, in its own layer so it is easy to see and easy to drop.
#
# Requirement tests run by `docker exec` inside this container, against the
# read-only /app mount — so whatever they need has to be baked in here. Nothing
# installs it at test time. Delete this layer (and requirements-test.txt) if you
# would rather keep the image free of test dependencies; the tests then only run
# where you install them yourself.
COPY requirements-test.txt ./
RUN pip install --no-cache-dir -r requirements-test.txt

# /app is the read-only source mount; keep Python from trying to write .pyc
# files into it (and uvicorn --reload only ever reads the tree).
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
