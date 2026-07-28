"""Structured logging tests (#4742, PMR-1.2).

The portable runtime promises that *every* line on stdout is one JSON object, uvicorn's own
lifecycle lines included, so a CI log collector needs exactly one parser.
"""

from __future__ import annotations

import json
import logging

from apiome_mock.logging_config import JsonLogFormatter, uvicorn_log_config


def _record(**overrides: object) -> logging.LogRecord:
    """Build a log record with sensible defaults for formatting tests."""
    kwargs: dict[str, object] = {
        "name": "uvicorn.error",
        "level": logging.INFO,
        "pathname": __file__,
        "lineno": 1,
        "msg": "Application startup complete.",
        "args": (),
        "exc_info": None,
    }
    kwargs.update(overrides)
    return logging.LogRecord(**kwargs)  # type: ignore[arg-type]


def test_stdlib_records_render_as_one_json_object() -> None:
    payload = json.loads(JsonLogFormatter().format(_record()))

    assert payload["event"] == "Application startup complete."
    assert payload["level"] == "info"
    assert payload["logger"] == "uvicorn.error"
    assert payload["timestamp"].endswith("Z")


def test_message_arguments_are_interpolated() -> None:
    payload = json.loads(JsonLogFormatter().format(_record(msg="Uvicorn running on %s", args=("http://x",))))

    assert payload["event"] == "Uvicorn running on http://x"


def test_exceptions_are_carried_in_the_json_object() -> None:
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        record = _record(level=logging.ERROR, msg="failed", exc_info=sys.exc_info())

    payload = json.loads(JsonLogFormatter().format(record))

    assert payload["level"] == "error"
    assert "ValueError: boom" in payload["exception"]


def test_the_formatter_output_is_always_a_single_line() -> None:
    """A multi-line record would break line-delimited log ingestion."""
    rendered = JsonLogFormatter().format(_record(msg="first\nsecond"))

    assert "\n" not in rendered
    assert json.loads(rendered)["event"] == "first\nsecond"


def test_uvicorn_is_configured_to_use_the_json_formatter() -> None:
    config = uvicorn_log_config("debug")

    assert config["formatters"]["json"]["()"].endswith(".JsonLogFormatter")
    assert set(config["loggers"]) == {"uvicorn", "uvicorn.error", "uvicorn.access"}
    for logger in config["loggers"].values():
        assert logger["handlers"] == ["default"]
        assert logger["level"] == "DEBUG"
        assert logger["propagate"] is False


def test_the_uvicorn_config_is_accepted_by_dictconfig() -> None:
    """A config uvicorn cannot load would silently fall back to plain-text logging."""
    import logging.config

    logging.config.dictConfig(uvicorn_log_config("INFO"))

    handler = logging.getLogger("uvicorn.error").handlers[0]
    assert isinstance(handler.formatter, JsonLogFormatter)
