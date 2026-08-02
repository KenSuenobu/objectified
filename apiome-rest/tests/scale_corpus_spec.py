"""Bridge to the committed scale-fixture generator — IXH-1.5 (#5091).

The scale fixtures (a multi-megabyte OpenAPI document, a 1500-method OpenRPC
service, a 900-type Avro snapshot, a 1500-transaction-set X12 interchange, …) are
*not* committed: ``scripts/generate_scale_corpus.py`` builds them at test time so
repository size stays flat, the same rule IXH-1.4 established for the adversarial
tier. That script lives outside the package, so this module loads it by path and
re-exports its spec for the benchmark suite.

Fixtures are materialized once per test session (see the ``scale_corpus_dir``
fixture in :mod:`tests.test_scale_corpus`), since building the set costs a few
seconds and ~7 MiB of disk.

This module deliberately imports nothing from ``app``: ``tests/conftest.py`` consults
:func:`scale_suite_enabled` on *every* pytest run to decide whether to skip the
suite, and paying for the service's import graph to answer that would tax runs that
never touch the scale tier.
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any, List

#: Monorepo root (parent of ``apiome-rest/``).
_REPO_ROOT = Path(__file__).resolve().parents[2]

#: The committed generator script.
GENERATOR_PATH = _REPO_ROOT / "scripts" / "generate_scale_corpus.py"

#: Environment variable that opts a local run into the scale suite.
ENABLE_ENV = "RUN_SCALE_SUITE"

__all__ = [
    "ENABLE_ENV",
    "GENERATOR_PATH",
    "load_generator",
    "scale_fixtures",
    "scale_paradigms",
    "scale_suite_enabled",
]


def load_generator() -> Any:
    """Import and return the generator module.

    Returns:
        The loaded ``generate_scale_corpus`` module.

    Raises:
        FileNotFoundError: If the committed script is missing — the scale contract
            requires it, so its absence must fail loudly rather than skip.
    """
    if not GENERATOR_PATH.exists():
        raise FileNotFoundError(f"the committed scale generator is missing: {GENERATOR_PATH}")
    spec = importlib.util.spec_from_file_location("generate_scale_corpus", GENERATOR_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register before executing: ``dataclasses`` resolves a field's annotations via
    # ``sys.modules[cls.__module__]``, which fails for a module loaded purely by path.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def scale_fixtures() -> List[Any]:
    """Return the generator's fixture spec (a list of ``ScaleFixture``)."""
    return list(load_generator().SCALE_FIXTURES)


def scale_paradigms() -> List[str]:
    """Return the canonical paradigms the scale tier is required to cover."""
    return list(load_generator().PARADIGMS)


def scale_suite_enabled(config: Any = None) -> bool:
    """Whether the scale suite should run in this invocation.

    Opt-in by acceptance criterion: the suite costs minutes and hundreds of
    megabytes, so it runs on demand locally (``RUN_SCALE_SUITE=1`` or ``--scale``)
    and on a schedule in CI — never on every PR.

    Args:
        config: The pytest ``config`` object, when available.

    Returns:
        ``True`` when the suite is enabled.
    """
    if os.environ.get(ENABLE_ENV) == "1":
        return True
    if config is None:
        return False
    return bool(config.getoption("--scale", default=False))
