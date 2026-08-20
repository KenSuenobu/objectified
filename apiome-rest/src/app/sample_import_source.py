"""No-op sample import source — MFI-1.1 (#3733).

The acceptance adapter for the ImportSource SPI: a deliberately trivial
:class:`~app.import_source.ImportSource` that *registers and appears in the source
list* with **no engine or wizard changes** — the whole point of the seam. It is
also the smallest possible worked example of the contract for a format epic to
copy.

It is a *no-op*: :meth:`SampleImportSource.detect` never claims an input (so it is
never auto-selected over a real format), :meth:`SampleImportSource.parse` just
wraps the raw text, and :meth:`SampleImportSource.normalize` returns a minimal but
valid :class:`~app.canonical_model.CanonicalApi`. The inherited
fingerprint/diff/lint defaults work on it unchanged.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from .canonical_model import ApiIdentity, ApiParadigm, CanonicalApi
from .import_source import (
    NO_MATCH,
    DetectionInput,
    DetectionResult,
    ImportSource,
    InputKind,
)

__all__ = ["SampleImportSource"]

#: Format key this adapter reports; it has no normalizer of its own because the
#: adapter builds the canonical model directly.
SAMPLE_FORMAT = "sample-noop"


class SampleImportSource(ImportSource, register=True):
    """A no-op reference adapter demonstrating the ImportSource SPI."""

    key = "sample"
    label = "Sample (no-op)"
    description = "A no-op reference adapter that demonstrates the ImportSource SPI."
    icon = "flask-conical"
    paradigm = ApiParadigm.DATA_SCHEMA
    input_kinds = (InputKind.PASTE,)
    supports_live_discovery = False
    formats = (SAMPLE_FORMAT,)
    # Declares no `file_extensions` (FMT-1.1) and needs no justification entry: `input_kinds` is
    # paste-only, so this adapter never reaches a file picker and has no filename to accept.
    file_extensions = ()
    # The sample source is a no-op stub: it exercises the job pipeline without ever writing a
    # catalog item, so submit→poll→terminal can be verified DB-free (real adapters persist).
    preview_only = True

    def detect(self, payload: DetectionInput) -> DetectionResult:
        """Never claim an input — the sample is chosen explicitly, not detected."""
        return NO_MATCH

    def parse(self, raw: str, *, source_label: Optional[str] = None) -> Dict[str, Any]:
        """Wrap the raw text as the adapter's trivial native AST."""
        return {"text": raw, "label": source_label}

    def normalize(self, native_ast: Any, *, include_raw: bool = True) -> CanonicalApi:
        """Return a minimal but valid canonical model for the sample input."""
        return CanonicalApi(
            paradigm=self.paradigm,
            format=SAMPLE_FORMAT,
            identity=ApiIdentity(name="Sample API"),
            raw={"source": native_ast} if include_raw else None,
        )
