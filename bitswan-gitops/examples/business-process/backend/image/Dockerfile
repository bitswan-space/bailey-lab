# FastAPI worker: a private backend reachable only on the Docker network.
# App source is mounted at /app at runtime; deps are baked for a fast start.
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt /deps/requirements.txt
RUN pip install --no-cache-dir -r /deps/requirements.txt
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]
