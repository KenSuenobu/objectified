"""dbt import source — FMT-5.4 (#5442).

The :class:`~app.import_source.ImportSource` adapter that makes a dbt project importable —
the analytics-engineering on-ramp.

For most analytics teams the *only* formal description of their data is a dbt project:
``schema.yml`` model and column definitions, the tests beside them, and the
``manifest.json`` dbt compiles from the two. None of it was readable by Apiome, so the
audience that owns the warehouse had no way in at all. This adapter reads a properties
file, a compiled manifest, or a whole project directory, and lands them in the same
catalog — and, for their expectations, the same quality namespace — as the ODCS contracts
FMT-5.1 reads.

Parsing, detection, version gating and lineage resolution live in :mod:`app.dbt_parser`;
the document algebra and the declared limits in :mod:`app.dbt_resources`; the canonical
projection and the ``dbt_*`` extras namespace in :mod:`app.dbt_normalizer`. This adapter is
read-only: dbt owns its own project files, and Apiome writing one back would put a second
author on a directory that is already under version control.
"""

from __future__ import annotations

from typing import Any, Optional

from . import dbt_normalizer  # noqa: F401 — self-registers the normalizer
from .canonical_model import ApiParadigm, CanonicalApi
from .dbt_parser import DBT_SUFFIXES, is_dbt, parse_dbt, parse_dbt_fileset
from .dbt_resources import LIMIT_DETAILS, DbtParseError, DbtProject
from .fileset import IntakeFileset
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    ImportSourceError,
    InputKind,
)
from .payload_analysis import AnalyzerCapabilities, analyzer_capabilities

__all__ = ["DBT_CAPABILITIES", "DbtImportSource"]

#: What the reader models and what it knowingly does not (CPDO-1.2 / CPDO-2.4).
#:
#: The ``unsupported`` half is the ticket's "carry what the canonical model has no home
#: for, and say so" in machine-readable form, and it is exactly
#: :data:`app.dbt_resources.LIMIT_DETAILS` — the same vocabulary the per-document coverage
#: ledger names — rather than a second list free to drift from it.
DBT_CAPABILITIES: AnalyzerCapabilities = analyzer_capabilities(
    supported=[
        "dbt.properties_file",
        "dbt.compiled_manifest",
        "dbt.project_fileset",
        "dbt.model",
        "dbt.source_table",
        "dbt.seed",
        "dbt.snapshot",
        "dbt.semantic_model",
        "dbt.column",
        "dbt.description",
        "dbt.not_null_test",
        "dbt.accepted_values_test",
        "dbt.not_null_constraint",
        "dbt.warehouse_type_base_name",
        "dbt.yaml_anchor_composition",
        "dbt.lineage_resolution",
    ],
    unsupported=sorted(LIMIT_DETAILS),
)


class DbtImportSource(ImportSource, register=True):
    """Adapter for dbt properties files, compiled manifests and project directories."""

    key = "dbt"
    label = "dbt Project"
    description = (
        "Import a dbt project — a `schema.yml` properties file, a compiled "
        "`manifest.json`, or a whole project directory — as a schemas-only catalog "
        "source. Models, sources, seeds, snapshots and semantic models become types; "
        "dbt tests become constraints or shared-namespace quality rules; `ref()` lineage "
        "is recorded as relationships."
    )
    icon = "database"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.FILE, InputKind.URL, InputKind.PASTE, InputKind.FILESET)
    supports_live_discovery = False
    formats = ("dbt",)
    file_extensions = DBT_SUFFIXES

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Claim a dbt project description.

        Claims a properties file, a ``dbt_project.yml`` and a compiled manifest alike. A
        model's ``.sql`` is deliberately **not** claimed: it is Jinja-templated SQL with
        no marker of its own, and a sniffer that claimed it would claim every SQL file in
        the world. Those files reach this adapter as *members* of a project file set,
        where the set's root has already identified the format.

        Args:
            payload: The detection input.

        Returns:
            A :class:`DetectionResult` naming ``dbt``, or :data:`NO_MATCH`.
        """
        text = payload.text
        if text is None or not is_dbt(text):
            return NO_MATCH
        return DetectionResult(
            confidence=0.93,
            format="dbt",
            reason=(
                "a dbt project description — `version: 2` with a properties list, a "
                "`config-version:` project file, or a manifest's `dbt_schema_version`"
            ),
        )

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> DbtProject:
        """Parse one dbt document.

        Args:
            raw: The document text (YAML, or the JSON a manifest is).
            source_label: The document's name, for error messages.

        Returns:
            The read :class:`~app.dbt_resources.DbtProject`.

        Raises:
            ImportSourceError: With the reader's taxonomy code when it can classify the
                failure, and without one when the pipeline should classify it.
        """
        try:
            return parse_dbt(raw, source_label=source_label)
        except DbtParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def parse_fileset(
        self,
        fileset: IntakeFileset,
        *,
        source_label: Optional[str] = None,
    ) -> DbtProject:
        """Parse a dbt project published across several files.

        A dbt project *is* a directory — that is how the tool is used — so this is the
        format's ordinary shape rather than an include mechanism. The project file names
        the project, every properties file contributes its resources to one shared
        namespace so a model and a source in different files resolve against each other,
        and each model's ``.sql`` contributes the ``ref()``/``source()`` calls in it as
        that model's lineage. No SQL is compiled or executed.

        Args:
            fileset: The intake fileset, rooted at the project's entry document.
            source_label: Fallback label when the set names no root.

        Returns:
            The composed project.

        Raises:
            ImportSourceError: If the root is missing, if the set describes no data, or if
                a recorded lineage edge names a model the set does not contain.
        """
        root = fileset.root
        if root not in fileset.members:
            raise ImportSourceError(
                "dbt file set is missing its root document", code="INPUT_SEMANTIC_INVALID"
            )
        try:
            return parse_dbt_fileset(fileset.members, root=root, source_label=source_label)
        except DbtParseError as exc:
            raise ImportSourceError(str(exc), code=exc.code) from exc

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Normalize a read project onto the canonical data-schema model.

        Args:
            native_ast: The read project.
            include_raw: Whether to retain the source text in the fidelity bag.

        Returns:
            The canonical model.

        Raises:
            ImportSourceError: If ``native_ast`` is not a read dbt project.
        """
        if not isinstance(native_ast, DbtProject):
            raise ImportSourceError(
                "dbt source must be a DbtProject (see app.dbt_parser.parse_dbt)"
            )
        return self._normalize_via_registry("dbt", native_ast, include_raw=include_raw)

    def analysis_capabilities(self) -> AnalyzerCapabilities:
        """Return the reader's declared construct coverage (CPDO-1.2)."""
        return DBT_CAPABILITIES
