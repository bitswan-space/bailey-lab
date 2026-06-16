FROM python:3.12-slim

# Dependencies are baked into the image (content-addressed by the image/ tree
# hash, like the Go worker's go.mod). The application source is bind-mounted at
# /app read-only at runtime, so nothing is written back into the source tree.
WORKDIR /deps
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# /app is the read-only source mount; keep Python from trying to write .pyc
# files into it (and uvicorn --reload only ever reads the tree).
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
