# FastAPI worker image. The build context is this image/ dir, so the
# dependency manifest lives here and is baked in. The app source (app.py)
# is bind-mounted at /app at runtime — not copied in — so edits hot-reload
# without a rebuild.
FROM python:3.11-slim
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt
WORKDIR /app
ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT:-8080}"]
