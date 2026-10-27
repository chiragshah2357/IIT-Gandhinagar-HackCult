"""Guards around the routes: API key, rate limit, body size, request ids and logging."""

from __future__ import annotations

import hmac
import json
import logging
import math
import re
import threading
import time
import uuid
from collections.abc import Awaitable, Callable, MutableMapping
from contextvars import ContextVar
from typing import Any

from fastapi import Header, HTTPException, Request, status
from starlette.types import ASGIApp, Message, Receive, Scope, Send

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{8,64}$")


# ------------------------------------------------------------------ API key


def require_ingest_key(
    request: Request,
    x_api_key: str | None = Header(default=None),
) -> None:
    """Writes need the shared key. With no key configured, writes are off: closed by default, never open."""
    configured = request.app.state.settings.ingest_api_key
    if configured is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "ingestion is disabled: no API key is configured")
    # Compare as bytes, in constant time, so the key cannot be guessed from response timing.
    if x_api_key is None or not hmac.compare_digest(x_api_key.encode(), configured.get_secret_value().encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing or wrong X-API-Key")


# ------------------------------------------------------------------ rate limit


class FixedWindowLimiter:
    """At most `limit` calls per client in each window. In-process, so it is per instance, not global."""

    def __init__(
        self,
        limit: int,
        window_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = limit
        self.window = window_seconds
        self._clock = clock
        self._hits: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def check(self, client: str) -> float | None:
        """None when allowed, otherwise the seconds until the client may try again."""
        if self.limit <= 0:
            return None
        now = self._clock()
        with self._lock:
            if len(self._hits) > 10_000:  # forget windows that have ended, so memory stays bounded
                self._hits = {k: v for k, v in self._hits.items() if now - v[0] < self.window}
            started, count = self._hits.get(client, (now, 0))
            if now - started >= self.window:
                started, count = now, 0
            if count >= self.limit:
                return max(0.0, self.window - (now - started))
            self._hits[client] = (started, count + 1)
            return None


def rate_limit(request: Request) -> None:
    # The socket address, not X-Forwarded-For: a header the client controls must not pick its own bucket.
    client = request.client.host if request.client else "unknown"
    retry = request.app.state.limiter.check(client)
    if retry is not None:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "too many requests",
            headers={"Retry-After": str(max(1, math.ceil(retry)))},
        )


# ------------------------------------------------------------------ body size


class BodySizeLimit:
    """Refuses request bodies over a limit with 413, whether or not the client declares a length.

    A declared Content-Length is checked up front. A body with no declared length (chunked) is read, up to the
    limit, before the app sees it: past the limit it is refused, and within it the app gets it replayed. That
    keeps the refusal out of the framework's own body parsing, which would turn it into a 400.
    """

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None:
            try:
                too_big = int(declared) > self.max_bytes
            except ValueError:
                await self._reject(send, 400, "invalid Content-Length")
                return
            if too_big:
                await self._reject(send, 413, "request body too large")
                return
            await self.app(scope, receive, send)
            return

        buffered: list[Message] = []
        received = 0
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] != "http.request":
                break  # the client went away
            received += len(message.get("body", b""))
            if received > self.max_bytes:
                await self._reject(send, 413, "request body too large")
                return
            if not message.get("more_body", False):
                break

        replay = iter(buffered)

        async def replaying_receive() -> Message:
            try:
                return next(replay)
            except StopIteration:
                return await receive()

        await self.app(scope, replaying_receive, send)

    @staticmethod
    async def _reject(send: Send, code: int, detail: str) -> None:
        body = json.dumps({"detail": detail}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": code,
                "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
            }
        )
        await send({"type": "http.response.body", "body": body})


# ------------------------------------------------------------------ request id and logging

log = logging.getLogger("lifecity.request")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: MutableMapping[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            payload.update(extra)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str) -> None:
    root = logging.getLogger("lifecity")
    root.setLevel(level.upper())
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(JsonFormatter())
        root.addHandler(handler)
    root.propagate = False


async def request_context(request: Request, call_next: Callable[[Request], Awaitable[Any]]) -> Any:
    """Tag each request with an id (kept if the caller sent a sane one), log it, and echo the id back."""
    incoming = request.headers.get("x-request-id", "")
    rid = incoming if _SAFE_REQUEST_ID.match(incoming) else uuid.uuid4().hex
    token = request_id_var.set(rid)
    started = time.perf_counter()
    try:
        response = await call_next(request)
        response.headers["X-Request-ID"] = rid
        log.info(
            "request",
            extra={
                "fields": {
                    "method": request.method,
                    "path": request.url.path,
                    "status": response.status_code,
                    "ms": round((time.perf_counter() - started) * 1000, 1),
                }
            },
        )
        return response
    except Exception:
        log.exception("unhandled error", extra={"fields": {"method": request.method, "path": request.url.path}})
        raise
    finally:
        request_id_var.reset(token)
