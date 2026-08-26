"""Apiome command-line client."""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _package_version

#: Fallback used only when the package is not installed (a source checkout run
#: straight off ``src`` without ``uv sync``). Every installed invocation reads the
#: real distribution metadata instead.
_FALLBACK_VERSION = "0.0.0+unknown"

try:
    # Single source of truth: ``--version`` must never disagree with the package it
    # came from. Hard-coding the string here let it drift five minor versions behind
    # pyproject.toml, which is exactly the failure this avoids.
    __version__ = _package_version("apiome-cli")
except PackageNotFoundError:  # pragma: no cover - only in an uninstalled checkout
    __version__ = _FALLBACK_VERSION

__all__ = ["__version__"]
