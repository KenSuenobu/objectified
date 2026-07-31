"""Quality scoring for a spec discovered by the repository scanner (REPO-2.8, #2769).

The REPO-2 scanner classifies each discovered file by filename only, which answers "what is
this?" but not "is it any good?". This module answers the second question with a rough 0-100
score per *classified* spec, so an operator can triage a repository's specs from the Files tab
without opening each one.

Nothing here is new scoring logic. A discovered spec is scored by the engines the platform
already grades imports with, reached through the import-source adapter registry:

* ``parse`` turns the file text into the format's native AST;
* ``normalize`` maps it onto the canonical model; and
* ``lint`` rolls findings up to the weighted 0-100 score and A-F grade — for OpenAPI that is
  the native path/schema linter (:func:`app.schema_lint.lint_openapi_spec`, the PATH-QUALITY
  and SCHEMA-QUALITY rule groups), and for every other format the canonical-model rule packs
  behind :meth:`app.import_source.ImportSource.lint`.

Reusing the import path means a repository file and an imported revision are graded on one
comparable scale, and a rule added to either engine shows up here for free.

Two properties matter to callers:

* **Pure.** No database and no network — the caller supplies the already-fetched text. The
  adapters themselves are contractually deterministic and side-effect free, so the same
  document always yields the same score.
* **Never raises.** Every failure path (unparseable document, missing toolchain, adapter bug)
  returns an outcome carrying a stable machine reason instead of propagating. The score is
  informational; it must never be able to break a scan, a refresh, or an import. Gating on
  spec quality is the REPO-5.6 promotion gates' job, not this module's.
"""

from __future__ import annotations

import logging
from typing import Mapping, NamedTuple, Optional

from .repository_file_scan import json_schema_shaped_path

_logger = logging.getLogger(__name__)

#: Largest document the scorer will read. Mirrors the repository file-content endpoint's cap,
#: so a file the UI refuses to open in one response is not silently linted in the background.
MAX_SCORE_BYTES: int = 900_000

# --- Outcome vocabulary ---------------------------------------------------------------------

#: The engine produced a score for the document.
STATUS_SCORED = "scored"
#: The file was deliberately not scored (unclassified, no adapter, too large, ...).
STATUS_SKIPPED = "skipped"
#: Scoring was attempted and failed (unparseable document, adapter error, fetch failure).
STATUS_ERROR = "error"

#: The file carries no spec classification — the ``unknown_spec`` case the roadmap excludes.
REASON_UNCLASSIFIED = "unclassified"
#: The file is classified, but no import adapter is registered for that format.
REASON_NO_ADAPTER = "no-adapter"
#: An adapter exists but its required toolchain is missing in this runtime (MFI-5.2).
REASON_ADAPTER_UNAVAILABLE = "adapter-unavailable"
#: The document was empty or whitespace-only.
REASON_EMPTY = "empty-document"
#: The document exceeds :data:`MAX_SCORE_BYTES`, or was truncated on the way in.
REASON_TOO_LARGE = "too-large"
#: The provider refused or failed the content download.
REASON_FETCH_FAILED = "fetch-failed"
#: The provider is not one this scorer can read file contents from.
REASON_PROVIDER_UNSUPPORTED = "provider-unsupported"
#: The adapter could not parse the text as its format.
REASON_PARSE_FAILED = "parse-failed"
#: The document parsed but could not be mapped onto the canonical model.
REASON_NORMALIZE_FAILED = "normalize-failed"
#: The lint engine raised while rolling the model up.
REASON_LINT_FAILED = "lint-failed"
#: The adapter declined to score (an adapter may return a report with no score).
REASON_UNSCORED = "unscored"

# --- Classification -------------------------------------------------------------------------

#: ``detected_kind`` prefix → import-source registry key.
#:
#: Keys must stay in lockstep with :func:`app.repository_file_scan.detected_kind_from_path`
#: (which produces the kinds) and with ``Database.REPOSITORY_FILE_IMPORTABLE_SQL`` (which
#: decides which of them are importable at all). A classified kind with no entry here is
#: importable but not scorable — ``prisma``, ``sql-ddl`` and ``dbml`` have no import adapter
#: yet, so they resolve to ``None`` and are skipped with :data:`REASON_NO_ADAPTER`.
_KIND_PREFIX_TO_SOURCE_KEY: Mapping[str, str] = {
    "openapi": "openapi",
    "swagger": "openapi",
    "arazzo": "arazzo",
    "asyncapi": "asyncapi",
    "graphql": "graphql",
    "protobuf": "grpc",
    "postman": "postman",
    "avro": "avro",
}


#: Every ``detected_kind`` prefix the scanner treats as a classified spec, whether or not an
#: adapter exists to score it. Must stay in lockstep with
#: :func:`app.repository_file_scan._importable_hint` and
#: ``Database.REPOSITORY_FILE_IMPORTABLE_SQL``, which select the same rows in Python and SQL.
_CLASSIFIED_KIND_PREFIXES = (
    "openapi",
    "swagger",
    "arazzo",
    "asyncapi",
    "graphql",
    "protobuf",
    "postman",
    "prisma",
    "sql-ddl",
    "avro",
    "dbml",
)


def is_classified_spec(detected_kind: Optional[str], path: str = "") -> bool:
    """Whether the scanner classified this file as a spec at all.

    The roadmap's "skip ``unknown_spec``" rule in one predicate: a file with no
    ``detected_kind``, or one whose kind is a generic container hint (``json-candidate`` on a
    ``package.json``, ``yaml-candidate`` on a CI config), is not a spec and is never scored.
    A classified spec whose format has no adapter yet (Prisma, SQL DDL, DBML) is still
    classified — it is skipped later, for a different and clearly labelled reason.

    Args:
        detected_kind: The scanner's filename classification, or ``None``.
        path: The repository-relative path, needed to tell a JSON Schema document apart from
            any other ``.json`` file (both are labelled ``json-candidate``).

    Returns:
        ``True`` when the file is a classified spec.
    """
    if not detected_kind:
        return False
    kind = detected_kind.strip().lower()
    if any(kind.startswith(prefix) for prefix in _CLASSIFIED_KIND_PREFIXES):
        return True
    return _is_json_schema(kind, path)


def _is_json_schema(detected_kind: Optional[str], path: str) -> bool:
    """Whether a generic ``json-candidate`` is JSON Schema-shaped by its path."""
    if not detected_kind:
        return False
    return detected_kind.lower().startswith("json") and json_schema_shaped_path(path)


def resolve_spec_source_key(detected_kind: Optional[str], path: str = "") -> Optional[str]:
    """Map a scanner classification onto the import-source adapter that can score it.

    Args:
        detected_kind: The scanner's filename classification (e.g. ``openapi-candidate``), or
            ``None`` for an unclassified file.
        path: The repository-relative path. Only consulted for ``json-candidate``, where the
            filename shape (``*.schema.json`` or under ``schemas/``) is the sole signal that
            separates a JSON Schema document from a lockfile or config.

    Returns:
        The registry key to score with, or ``None`` when the file is unclassified or its
        format has no adapter (either case is a skip, distinguished by the caller).
    """
    if not detected_kind:
        return None
    kind = detected_kind.strip().lower()
    if not kind:
        return None
    for prefix, key in _KIND_PREFIX_TO_SOURCE_KEY.items():
        if kind.startswith(prefix):
            return key
    if _is_json_schema(kind, path):
        return "json-schema"
    return None


# --- Scoring --------------------------------------------------------------------------------


class SpecQualityOutcome(NamedTuple):
    """The result of one scoring attempt.

    Attributes:
        status: :data:`STATUS_SCORED`, :data:`STATUS_SKIPPED`, or :data:`STATUS_ERROR`.
        score: The 0-100 score, present only when ``status`` is ``scored``.
        grade: The A-F letter grade, present only when ``status`` is ``scored``.
        reason: A stable machine reason for a skip or error; ``None`` when scored.
    """

    status: str
    score: Optional[int]
    grade: Optional[str]
    reason: Optional[str]

    @property
    def scored(self) -> bool:
        """Whether this outcome carries a usable score."""
        return self.status == STATUS_SCORED


def skipped(reason: str) -> SpecQualityOutcome:
    """Build a "deliberately not scored" outcome carrying ``reason``."""
    return SpecQualityOutcome(status=STATUS_SKIPPED, score=None, grade=None, reason=reason)


def failed(reason: str) -> SpecQualityOutcome:
    """Build a "tried and could not score" outcome carrying ``reason``."""
    return SpecQualityOutcome(status=STATUS_ERROR, score=None, grade=None, reason=reason)


def score_spec_text(
    detected_kind: Optional[str],
    path: str,
    text: Optional[str],
    *,
    truncated: bool = False,
    max_bytes: int = MAX_SCORE_BYTES,
) -> SpecQualityOutcome:
    """Score one discovered spec document, never raising.

    Runs the classified file's import adapter over the text — parse, normalize, lint — and
    returns the lint roll-up's 0-100 score and A-F grade. An unclassified file, a format with
    no adapter, an adapter whose toolchain is unavailable, an oversized or truncated document,
    and any adapter failure all come back as a non-scored outcome with a stable reason rather
    than an exception.

    Args:
        detected_kind: The scanner's filename classification for the file.
        path: Repository-relative path; used to classify JSON Schema and to label parse errors.
        text: The already-fetched document text, or ``None`` when the fetch produced nothing.
        truncated: Whether the fetch stopped at a byte cap. A partial document would score
            against material the file does not actually contain, so it is skipped.
        max_bytes: Largest document to score, in UTF-8 bytes.

    Returns:
        The :class:`SpecQualityOutcome` for this document.
    """
    source_key = resolve_spec_source_key(detected_kind, path)
    if source_key is None:
        # Two different skips share this branch: a file the scanner never classified as a spec
        # (the ``unknown_spec`` case), and a classified format with no adapter to score it yet.
        # The reason keeps them apart for the Files tab.
        reason = (
            REASON_NO_ADAPTER if is_classified_spec(detected_kind, path) else REASON_UNCLASSIFIED
        )
        return skipped(reason)

    if truncated:
        return skipped(REASON_TOO_LARGE)
    if text is None or not text.strip():
        return skipped(REASON_EMPTY)
    if len(text.encode("utf-8", errors="ignore")) > max_bytes:
        return skipped(REASON_TOO_LARGE)

    # Imported lazily: the adapter registry pulls in every format module, which is far too much
    # to load for callers that only need the classification helpers above.
    from .import_source import get_import_source

    try:
        adapter = get_import_source(source_key)
    except Exception:  # noqa: BLE001 - registry problems must not escape a best-effort score
        _logger.warning("repository spec quality: adapter lookup failed for %s", path, exc_info=True)
        return failed(REASON_NO_ADAPTER)
    if adapter is None:
        return skipped(REASON_NO_ADAPTER)

    try:
        if not adapter.descriptor().available:
            # e.g. gRPC needs `buf` on PATH; without it parse cannot run at all (MFI-5.2).
            return skipped(REASON_ADAPTER_UNAVAILABLE)
    except Exception:  # noqa: BLE001 - a descriptor that cannot report is treated as unusable
        _logger.warning("repository spec quality: descriptor failed for %s", path, exc_info=True)
        return skipped(REASON_ADAPTER_UNAVAILABLE)

    try:
        native = adapter.parse(text, source_label=path)
    except Exception:  # noqa: BLE001 - an unparseable file in a repo is ordinary, not exceptional
        return failed(REASON_PARSE_FAILED)

    try:
        # include_raw keeps the native document on the model, which is what the OpenAPI
        # adapter's linter (the PATH-QUALITY / SCHEMA-QUALITY rules) reads.
        model = adapter.normalize(native, include_raw=True)
    except Exception:  # noqa: BLE001
        return failed(REASON_NORMALIZE_FAILED)

    try:
        report = adapter.lint(model)
    except Exception:  # noqa: BLE001
        _logger.warning("repository spec quality: lint failed for %s", path, exc_info=True)
        return failed(REASON_LINT_FAILED)

    if report is None or report.score is None:
        return skipped(REASON_UNSCORED)

    score = max(0, min(100, int(report.score)))
    grade = str(report.grade) if report.grade else None
    return SpecQualityOutcome(status=STATUS_SCORED, score=score, grade=grade, reason=None)
