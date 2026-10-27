# LiFE City API

FastAPI and Postgres service behind the control room. It stores the campus buildings, ingests power readings, and
runs the Mission LiFE scenario simulation on the server.

**What it is and is not.** Every number the simulation returns is modelled from building-type profiles. Readings can
be stored, but nothing uses them yet: baselines are not fitted from readings, and a building is only flagged
`measured` once readings exist for it. The carbon curve, tariff and campaign effects are placeholders (see
[docs/data-and-sources.md](../docs/data-and-sources.md)). There is no user login yet; writes use one shared API key.

## Run it

With Docker (Postgres and the API, migrated and seeded):

```bash
cp .env.example .env        # then set LIFECITY_INGEST_API_KEY and POSTGRES_PASSWORD
docker compose up --build
```

The API is at <http://localhost:8000>, with interactive docs at `/docs`.

Without Docker, from `api/`, against any Postgres (or `sqlite:///./lifecity.db` for a quick look):

```bash
python -m venv .venv && . .venv/bin/activate        # on Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
export LIFECITY_DATABASE_URL=sqlite:///./lifecity.db LIFECITY_INGEST_API_KEY=dev-key-change-me
alembic upgrade head
python -m app.seed                                    # loads web/app/data/assets.js, safe to repeat
uvicorn app.asgi:app --reload
```

Checks, as run in CI against a real Postgres:

```bash
ruff check . && ruff format --check . && mypy && pytest
LIFECITY_TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost/test pytest   # to test on Postgres
```

## Endpoints

| Method and path | What it does |
| --- | --- |
| `GET /healthz`, `GET /readyz` | Process is up; database answers (503 when it does not) |
| `GET /model` | The building types and the five campaigns the simulation knows |
| `GET /campuses`, `GET /campuses/{id}/buildings`, `GET /buildings/{id}` | Campuses and buildings, with a `measured` or `modelled` flag |
| `GET /buildings/{id}/readings?from&to&limit` | Stored readings, oldest first |
| `POST /readings:batch` | Ingest readings. Needs `X-API-Key` and an `Idempotency-Key` |
| `POST /scenarios/simulate` | Hourly campus load with and without the chosen campaigns |

```bash
curl -s localhost:8000/scenarios/simulate -H 'content-type: application/json' \
  -d '{"campus": "mujaipur", "campaigns": ["ac26", "shift"], "day_type": "weekday"}'

curl -s localhost:8000/readings:batch -H 'content-type: application/json' \
  -H "X-API-Key: $LIFECITY_INGEST_API_KEY" -H 'Idempotency-Key: meter-gateway-2026-10-27-0001' \
  -d '{"readings": [{"building_id": 1, "ts": "2026-10-27T10:00:00+05:30", "kw": 312.4}]}'
```

## Behaviour worth knowing

- **Ingestion is all or nothing.** One bad reading refuses the whole batch and writes nothing, and the key is not
  consumed, so the client can fix it and retry with the same key.
- **Retries are safe.** The same `Idempotency-Key` with the same batch writes nothing the second time and returns the
  original counts (`replayed: true`). The same key with a different batch is a 409. Two requests racing on one key
  cannot both write: the key is claimed first, as a primary key insert.
- **Readings are immutable.** A reading for a meter and instant that already exists is counted as a duplicate and left
  as it was. Readings are average power in kW at an instant, with a timezone, stored as UTC.
- **Simulation is cached** by its parameters and the version of the data. `X-Cache` says `HIT`, `MISS` or `STALE`. If
  the database is down, the last answer for the same request is served as `STALE`; otherwise a clean 503.
- **Limits:** 5,000 readings per batch, 2 MB per body (also for chunked uploads), 120 POSTs a minute per client address
  (in-process, so per instance), and writes are off entirely until an API key is configured.
- **The model matches the front end.** `app/simulation/model.py` is a port of the model in `web/app/app.js`, and
  `tests/golden/` holds values generated from the JavaScript to prove it. After changing the model in `app.js`, run
  `node tests/golden/generate.mjs ../web/app/app.js` and commit the new JSON.

## Layout

```
app/
  main.py            application factory, middleware, error handlers
  routes.py          the HTTP surface, thin
  schemas.py         request and response shapes, all validation
  models.py          the database schema
  services/          ingestion, buildings, scenario simulation and its cache
  simulation/model.py  the load model: building types, hourly shapes, campaigns
  guards.py          API key, rate limit, body size limit, request ids, JSON logs
  seed.py            loads web/app/data/assets.js
alembic/             migrations (the tests run on them)
tests/               unit, API and race tests; golden/ holds the front end's own values
```

## Not built yet

Login and roles (the plan's JWT), a CSV upload route, fitting baselines from readings, verified savings, a `/metrics`
endpoint, Redis for the cache, monthly partitions for `readings`, and a retention job for `ingest_batches`.
