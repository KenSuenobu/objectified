"""Structured logging for the mock server.

Every line either runtime writes is a single JSON object, including the lines uvicorn writes: a CI
job that pipes the runtime's stdout into a log collector should never have to parse two formats.
:class:`JsonLogFormatter` and :func:`uvicorn_log_config` are what bring uvicorn's stdlib logging
into the same shape structlog produces.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import structlog

from apiome_mock.settings import Settings

_configured = False


class JsonLogFormatter(logging.Formatter):
    """Render a stdlib log record as one JSON object, matching the structlog renderer's shape.

    Keys mirror the structlog output (``event``, ``level``, ``timestamp``) so both sources can be
    consumed by one parser; ``logger`` names the emitting stdlib logger.
    """

    def format(self, record: logging.LogRecord) -> str:
        """Return the record as a compact JSON line.

        Args:
            record: The record to render.

        Returns:
            A single-line JSON object.
        """
        payload: dict[str, Any] = {
            "event": record.getMessage(),
            "level": record.levelname.lower(),
            "logger": record.name,
            "timestamp": datetime.fromtimestamp(record.created, timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def uvicorn_log_config(log_level: str) -> dict[str, Any]:
    """Build the ``logging.config.dictConfig`` uvicorn should use.

    Args:
        log_level: Level name applied to uvicorn's loggers.

    Returns:
        A dict config that routes every uvicorn logger through :class:`JsonLogFormatter`.
    """
    level = log_level.upper()
    return {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {"json": {"()": f"{__name__}.JsonLogFormatter"}},
        "handlers": {
            "default": {
                "class": "logging.StreamHandler",
                "formatter": "json",
                "stream": "ext://sys.stdout",
            }
        },
        "loggers": {
            name: {"handlers": ["default"], "level": level, "propagate": False}
            for name in ("uvicorn", "uvicorn.error", "uvicorn.access")
        },
    }


def reset_logging_state_for_tests() -> None:
    global _configured
    _configured = False
    structlog.reset_defaults()


def configure_logging(settings: Settings) -> None:
    """Configure JSON structured logging for the hosted runtime."""
    configure_portable_logging(settings.log_level)


def configure_portable_logging(log_level: str) -> None:
    """Configure JSON structured logging from a level name alone.

    The portable runtime (#4742) has its own settings object and no database URL, so it configures
    logging by level rather than by hosted :class:`Settings`. Both runtimes end up with the same
    renderer, which is what makes their log lines comparable in CI.

    Args:
        log_level: Level name (``"DEBUG"`` … ``"CRITICAL"``); unknown names fall back to ``INFO``.
    """
    global _configured
    if _configured:
        return
    level = getattr(logging, log_level.upper(), logging.INFO)
    logging.basicConfig(level=level, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )
    _configured = True
