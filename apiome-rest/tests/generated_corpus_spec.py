"""Bridge to the committed adversarial-fixture generator — IXH-1.4 (#5090).

The large adversarial fixtures (archive bombs, path-traversal archives, a 10^5-node
document, deep nesting, a YAML alias bomb, a 1 GiB sparse file) are *not* committed:
``scripts/generate_adversarial_corpus.py`` builds them at test time so repository
size stays flat. That script lives outside the package, so this module loads it by
path and re-exports its spec for the test suites.

Fixtures are materialized once per test session into a temporary directory (see the
``generated_adversarial_dir`` fixture in :mod:`tests.test_corpus_adversarial`), since
building the set costs a few seconds and ~12 MiB of real disk.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any, List, Set

if TYPE_CHECKING:  # pragma: no cover - typing only
    from corpus_loader import IntakeGuard

#: Monorepo root (parent of ``apiome-rest/``).
_REPO_ROOT = Path(__file__).resolve().parents[2]

#: The committed generator script.
GENERATOR_PATH = _REPO_ROOT / "scripts" / "generate_adversarial_corpus.py"

__all__ = [
    "GENERATOR_PATH",
    "generated_fixtures",
    "generated_guards",
    "load_generator",
]


def load_generator() -> Any:
    """Import and return the generator module.

    Returns:
        The loaded ``generate_adversarial_corpus`` module.

    Raises:
        FileNotFoundError: If the committed script is missing — the corpus contract
            requires it, so its absence must fail loudly rather than skip.
    """
    if not GENERATOR_PATH.exists():
        raise FileNotFoundError(
            f"the committed adversarial generator is missing: {GENERATOR_PATH}"
        )
    spec = importlib.util.spec_from_file_location("generate_adversarial_corpus", GENERATOR_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # Register before executing: ``dataclasses`` resolves a field's annotations via
    # ``sys.modules[cls.__module__]``, which fails for a module loaded purely by path.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def generated_fixtures() -> List[Any]:
    """Return the generator's fixture spec (a list of ``GeneratedFixture``)."""
    return list(load_generator().GENERATED_FIXTURES)


def generated_guards() -> Set["IntakeGuard"]:
    """Return the set of intake guards covered by generated fixtures.

    Returns:
        The guards as :class:`corpus_loader.IntakeGuard` members, so callers can
        union them with the manifest's guard coverage.
    """
    from corpus_loader import IntakeGuard

    return {IntakeGuard(fixture.guard) for fixture in generated_fixtures()}
