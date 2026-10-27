# Build from the repository root (docker compose does): the seed table lives in web/app/data/assets.js.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv/api
COPY api/requirements.txt .
RUN pip install -r requirements.txt

COPY api/ .
COPY web/app/data/assets.js /srv/web/app/data/assets.js
ENV LIFECITY_ASSETS_FILE=/srv/web/app/data/assets.js

RUN useradd --create-home --uid 10001 app && chown -R app /srv
USER app

EXPOSE 8000
# Migrate, seed (safe to repeat), then serve.
CMD ["sh", "-c", "alembic upgrade head && python -m app.seed && uvicorn app.asgi:app --host 0.0.0.0 --port 8000"]
