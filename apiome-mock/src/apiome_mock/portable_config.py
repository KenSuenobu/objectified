"""Declared configuration surface for the portable mock runtime (#4742, PMR-1.2).

The portable runtime has one configuration rule: **every knob is declared here, and nothing else
is read**. :data:`RUNTIME_OPTIONS` is the single source of truth — the ``apiome-mock run`` argument
parser is generated from it, :class:`PortableSettings` maps one-to-one onto it, and the reference
table in ``docs/guide/portable-mock-runtime.md`` is checked against it by the test suite. A knob
that is not in this list cannot be set, and a knob in this list is settable exactly two ways:

1. a command-line flag (``--port 9000``), which wins; or
2. an environment variable (``APIOME_MOCK_HTTP_PORT=9000``).

That matters for CI parity: a container and a laptop given the same flags and the same environment
resolve to byte-identical configuration, with no ``.env`` file, no config file, and no hidden
defaults picked up from the host.

Secrets are deliberately env-only. A bundle signing secret passed as ``--secret`` would be visible
in ``ps`` output and in shell history to every user on the machine, so
``APIOME_MOCK_BUNDLE_SECRET`` has no flag at all (:attr:`RuntimeOption.flag` is ``None``).
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from typing import Any, Literal, Mapping

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

__all__ = [
    "ENV_PREFIX",
    "RUNTIME_OPTIONS",
    "PortableSettings",
    "RuntimeOption",
    "add_runtime_arguments",
    "option_for_field",
    "settings_from_args",
]

#: Environment prefix shared with the hosted runtime, so one deployment vocabulary covers both.
ENV_PREFIX = "APIOME_MOCK_"

LogLevel = Literal["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"]


@dataclass(frozen=True)
class RuntimeOption:
    """One declared configuration knob of the portable runtime.

    Attributes:
        field: :class:`PortableSettings` field name this knob sets.
        flag: Long command-line flag (``"--port"``), or ``None`` for env-only knobs (secrets).
        env: Full environment variable name.
        help: One-line description, shown in ``--help`` and published in the docs table.
        metavar: Placeholder shown in ``--help`` for value-taking flags.
        kind: ``"value"`` for ``--flag VALUE``, ``"flag"`` for a boolean ``--flag`` switch.
    """

    field: str
    flag: str | None
    env: str
    help: str
    metavar: str | None = None
    kind: Literal["value", "flag"] = "value"


#: Every knob the portable runtime honors, in ``--help`` order. Nothing else is read.
RUNTIME_OPTIONS: tuple[RuntimeOption, ...] = (
    RuntimeOption(
        field="bundle",
        flag="--bundle",
        env=f"{ENV_PREFIX}BUNDLE",
        help="Path to the mock bundle (apiome.mock.bundle/v1 JSON document) to serve.",
        metavar="PATH",
    ),
    RuntimeOption(
        field="http_host",
        flag="--host",
        env=f"{ENV_PREFIX}HTTP_HOST",
        help="Bind address. Use 0.0.0.0 inside a container.",
        metavar="ADDR",
    ),
    RuntimeOption(
        field="http_port",
        flag="--port",
        env=f"{ENV_PREFIX}HTTP_PORT",
        help="TCP port to listen on.",
        metavar="PORT",
    ),
    RuntimeOption(
        field="base_path",
        flag="--base-path",
        env=f"{ENV_PREFIX}BASE_PATH",
        help=(
            "Path prefix the spec is served under. 'version' mirrors the hosted URL shape "
            "(/{tenant}/{project}/{version}/...); 'root' serves spec paths at /."
        ),
        metavar="{version,root}",
    ),
    RuntimeOption(
        field="require_signature",
        flag="--require-signature",
        env=f"{ENV_PREFIX}REQUIRE_SIGNATURE",
        help="Refuse to start unless the bundle carries a signature.",
        kind="flag",
    ),
    RuntimeOption(
        field="bundle_secret",
        flag=None,
        env=f"{ENV_PREFIX}BUNDLE_SECRET",
        help=(
            "Shared HMAC secret the bundle signature must verify against. Environment only, "
            "never a flag: command lines are world-readable via ps."
        ),
    ),
    RuntimeOption(
        field="log_level",
        flag="--log-level",
        env=f"{ENV_PREFIX}LOG_LEVEL",
        help="Structured log level (DEBUG, INFO, WARNING, ERROR, CRITICAL).",
        metavar="LEVEL",
    ),
    RuntimeOption(
        field="access_log",
        flag="--no-access-log",
        env=f"{ENV_PREFIX}ACCESS_LOG",
        help="Disable the per-request mock_request access log line (startup logs still emit).",
        kind="flag",
    ),
    RuntimeOption(
        field="callbacks_enabled",
        flag="--callbacks",
        env=f"{ENV_PREFIX}CALLBACKS_ENABLED",
        help=(
            "Deliver the bundle's contract callbacks/webhooks outbound. Off by default: a "
            "portable mock makes no network connections unless it is told to."
        ),
        kind="flag",
    ),
    RuntimeOption(
        field="callback_allow_private",
        flag="--callback-allow-private",
        env=f"{ENV_PREFIX}CALLBACK_ALLOW_PRIVATE",
        help=(
            "Permit callback destinations on loopback/private addresses, for a CI job whose "
            "webhook receiver runs beside the mock. Public-address-only otherwise."
        ),
        kind="flag",
    ),
    RuntimeOption(
        field="callback_timeout_seconds",
        flag="--callback-timeout",
        env=f"{ENV_PREFIX}CALLBACK_TIMEOUT_SECONDS",
        help="Ceiling on one callback delivery attempt, in seconds.",
        metavar="SECONDS",
    ),
    RuntimeOption(
        field="session_ttl_seconds",
        flag="--session-ttl",
        env=f"{ENV_PREFIX}SESSION_TTL_SECONDS",
        help="Sliding TTL for X-Mock-Session state, in seconds.",
        metavar="SECONDS",
    ),
    RuntimeOption(
        field="session_max_resources",
        flag="--session-max-resources",
        env=f"{ENV_PREFIX}SESSION_MAX_RESOURCES",
        help="Maximum stateful resources stored per session.",
        metavar="COUNT",
    ),
    RuntimeOption(
        field="session_max_bytes",
        flag="--session-max-bytes",
        env=f"{ENV_PREFIX}SESSION_MAX_BYTES",
        help="Maximum JSON byte size stored per session.",
        metavar="BYTES",
    ),
    RuntimeOption(
        field="session_max_sessions",
        flag="--session-max-sessions",
        env=f"{ENV_PREFIX}SESSION_MAX_SESSIONS",
        help="Maximum concurrent mock sessions held in memory.",
        metavar="COUNT",
    ),
)

_OPTIONS_BY_FIELD: Mapping[str, RuntimeOption] = {option.field: option for option in RUNTIME_OPTIONS}

#: Fields whose *value* must never be echoed in logs or ``--print-config`` output.
SECRET_FIELDS = frozenset({"bundle_secret"})


def option_for_field(field: str) -> RuntimeOption:
    """Return the declared option for a settings field.

    Args:
        field: A :class:`PortableSettings` field name.

    Returns:
        The matching :class:`RuntimeOption`.

    Raises:
        KeyError: The field is not declared — a programming error, not a user error.
    """
    return _OPTIONS_BY_FIELD[field]


class PortableSettings(BaseSettings):
    """Resolved configuration for one ``apiome-mock run`` process.

    Values come from the declared flags first and the declared environment variables second. Unlike
    the hosted :class:`~apiome_mock.settings.Settings`, this reads **no ``.env`` file** (a portable
    runtime must not pick up whatever happens to sit in the working directory) and requires no
    database URL — a bundle is the whole world it needs.
    """

    model_config = SettingsConfigDict(
        env_prefix=ENV_PREFIX,
        env_file=None,
        case_sensitive=False,
        extra="ignore",
    )

    bundle: str = Field(default="", description="Path to the mock bundle to serve.")
    http_host: str = Field(default="127.0.0.1", min_length=1)
    http_port: int = Field(default=8775, ge=1, le=65535)
    base_path: Literal["version", "root"] = Field(default="version")
    require_signature: bool = Field(default=False)
    bundle_secret: str | None = Field(default=None)
    log_level: LogLevel = Field(default="INFO")
    access_log: bool = Field(default=True)
    callbacks_enabled: bool = Field(default=False)
    callback_allow_private: bool = Field(default=False)
    callback_timeout_seconds: float = Field(default=5.0, gt=0, le=60.0)
    session_ttl_seconds: float = Field(default=3600.0, gt=0, le=86_400.0)
    session_max_resources: int = Field(default=200, ge=1, le=100_000)
    session_max_bytes: int = Field(default=1_048_576, ge=1024, le=100_000_000)
    session_max_sessions: int = Field(default=10_000, ge=1, le=1_000_000)

    @classmethod
    def isolated(cls, *, bundle: str, http_host: str = "127.0.0.1") -> "PortableSettings":
        """Build settings from the declared defaults alone, ignoring the environment entirely.

        Init values take precedence over environment variables in pydantic-settings, so passing
        every field explicitly is what makes this environment-free. ``apiome-mock selftest`` needs
        that: the corpus asserts fixed responses, and a deployment's ambient
        ``APIOME_MOCK_SESSION_MAX_RESOURCES`` (or ``APIOME_MOCK_BASE_PATH``) would otherwise change
        what the runtime under test does and fail cases that have nothing to do with the runtime.

        Args:
            bundle: Path to the bundle to serve.
            http_host: Bind address.

        Returns:
            Settings equal to the declared defaults, apart from ``bundle`` and ``http_host``.
        """
        defaults = {name: field.get_default(call_default_factory=True) for name, field in cls.model_fields.items()}
        defaults.update(bundle=bundle, http_host=http_host)
        return cls(**defaults)

    @field_validator("log_level", mode="before")
    @classmethod
    def normalize_log_level(cls, value: object) -> str:
        """Accept ``debug`` as readily as ``DEBUG`` from a flag or an environment variable."""
        return str(value).upper()

    def redacted(self) -> dict[str, Any]:
        """Render the resolved configuration for logs and ``--print-config``.

        Secret-bearing fields are reported as ``"set"``/``"unset"`` rather than by value, so the
        output is safe to paste into a bug report or a CI log.

        Returns:
            A JSON-serializable mapping of every declared field to its resolved value.
        """
        payload: dict[str, Any] = {}
        for option in RUNTIME_OPTIONS:
            value = getattr(self, option.field)
            if option.field in SECRET_FIELDS:
                payload[option.field] = "set" if value else "unset"
            else:
                payload[option.field] = value
        return payload


def add_runtime_arguments(parser: argparse.ArgumentParser) -> None:
    """Add every flag-bearing declared option to ``parser``.

    Flags default to ``None`` rather than to the settings default, so that "flag not given" stays
    distinguishable from "flag given the same value as the default" — only the former lets the
    environment variable take effect.

    Args:
        parser: The subcommand parser to populate.
    """
    for option in RUNTIME_OPTIONS:
        if option.flag is None:
            continue
        if option.kind == "flag":
            # ``--no-access-log`` stores False; every other switch stores True.
            negated = option.flag.startswith("--no-")
            parser.add_argument(
                option.flag,
                dest=option.field,
                action="store_const",
                const=not negated,
                default=None,
                help=option.help,
            )
            continue
        parser.add_argument(
            option.flag,
            dest=option.field,
            default=None,
            metavar=option.metavar,
            help=f"{option.help} [env: {option.env}]",
        )


def settings_from_args(args: argparse.Namespace) -> PortableSettings:
    """Resolve settings from parsed flags layered over the declared environment.

    Args:
        args: The namespace produced by a parser populated via :func:`add_runtime_arguments`.

    Returns:
        The validated :class:`PortableSettings`.

    Raises:
        pydantic.ValidationError: A flag or environment value is not valid for its field.
    """
    overrides = {
        option.field: getattr(args, option.field)
        for option in RUNTIME_OPTIONS
        if option.flag is not None and getattr(args, option.field, None) is not None
    }
    return PortableSettings(**overrides)
