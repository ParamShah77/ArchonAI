FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
COPY archon ./archon
RUN pip install .

ENV ARCHON_API_HOST=0.0.0.0 ARCHON_API_PORT=8001 ARCHON_WORKSPACE=/data/workspace \
    DATABASE_URL=sqlite+aiosqlite:////data/archon.db
VOLUME ["/data"]
EXPOSE 8001
CMD ["python", "-m", "uvicorn", "archon.main:app", "--host", "0.0.0.0", "--port", "8001"]
