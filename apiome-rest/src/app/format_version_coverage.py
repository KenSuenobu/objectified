"""Declared read/write version coverage per format — FMT-3.8 (#5433).

"Which versions of OpenAPI do you read?" had no machine-readable answer. It was prose in an
adapter docstring (*"OpenAPI 3.0/3.1/3.2 or Swagger 2.0"*), a label on an emitter (*"AsyncAPI
3.1"*), and a hand-written sentence in a sales deck — three derivations of one fact, each free to
be wrong in its own way and each drifting a little further as FMT-3.1…3.7 added Arazzo 1.1,
WSDL 2.0, OData v2/v3, Avro IDL, Swagger 1.2, Postman v2.0 and Protobuf Editions.

This module is that answer, stated once. For every format it declares:

* **the versions read** — each with the registry format key that selects it, which is also the key
  a corpus fixture detects as, so the claim is checkable against fixtures rather than trusted;
* **the versions written** — each with the emitter output-format key that produces it, which is
  the key the round-trip matrix records a row under;
* **the default write version** — what an export produces when the caller states no preference;
* **a note wherever the support is anything other than whole-version** — Swagger 1.2 read by
  projecting onto the 2.0 path, OData v2/v3 read by projecting onto the v4 model, AsyncAPI 2.6
  written by downgrading the 3.1 document.

**What a declaration is and is not.** :class:`VersionSupport` grades *the version*, not the
grammar: :attr:`VersionSupport.FULL` says documents of this version are a first-class target,
:attr:`VersionSupport.PARTIAL` says they are reached through a stated projection or downgrade, and
:attr:`VersionSupport.UNGATED` says the adapter does not branch on a version marker at all because
the format has none to branch on (a ``.thrift`` file declares no Thrift release). How completely a
format's *constructs* are modelled is a different question, and one the capability registry already
answers — :attr:`~app.format_capability_registry.FormatCapability.unsupported_constructs` and
:attr:`~app.format_capability_registry.FormatCapability.canonical_projection`. A row here never
restates it.

**Evidence, not assertion.** ``tests/test_format_version_coverage.py`` is the conformance suite the
ticket asks for: every declared read version must have at least one *valid* corpus entry that
detects at its ``format_key``, and every declared write version must have a round-trip matrix row
under its ``format_key``. A declaration without evidence fails CI, so this table cannot claim a
version the fixtures do not demonstrate.

The declaration is consumed by :mod:`app.format_capability_registry` (which hangs it on every
entry, and therefore on ``GET /v1/import/format-capabilities``), by :mod:`app.format_matrix` (and
therefore ``GET /v1/formats/matrix``) and by :mod:`app.supported_formats_doc` (the generated docs
page). One table, three surfaces, no fourth derivation.

Kept in its own module rather than inside the capability registry because it is *data*: a static,
import-free table a reviewer reads top to bottom, with no dependency on the adapter registry it
describes.
"""

from __future__ import annotations

from enum import Enum
from typing import Dict, List, Optional, Tuple

from pydantic import BaseModel, ConfigDict, Field, model_validator

__all__ = [
    "UNDECLARED_VERSION_COVERAGE",
    "FormatVersion",
    "VersionCoverage",
    "VersionSupport",
    "declared_version_coverage",
    "version_coverage_for",
]


class VersionSupport(str, Enum):
    """How a format's version is supported — a claim about the *version*, not the grammar.

    Kept to three members on purpose. A fourth grade ("mostly") would be a way of not answering,
    and the construct-level boundaries a reader actually needs are already published by the
    capability registry's ``unsupported_constructs`` and ``canonical_projection``.
    """

    #: The version is a first-class target: documents of it are read (or written) directly.
    FULL = "full"
    #: The version is reached through a stated projection or downgrade onto another version's
    #: pipeline. Always carries a note naming the projection.
    PARTIAL = "partial"
    #: The format carries no version marker the adapter branches on — one grammar covers every
    #: release. Always carries a note saying so, because "no version" and "one version" are
    #: different facts and only one of them is about the format.
    UNGATED = "ungated"


class FormatVersion(BaseModel):
    """One version (or authored surface) a format is read at or written at.

    Attributes:
        version: How the format itself spells this version (``3.1``, ``005010``, ``R4``). When the
            format has no version to spell, this names the grammar or authored surface the row
            covers (``Avro IDL (.avdl)``) and :attr:`support` is :attr:`VersionSupport.UNGATED`.
        format_key: The registry key that selects this version. On a **read** row it is a key the
            adapter declares and a document of this version detects as, which is what makes the
            row checkable against the corpus. On a **write** row it is the emitter's output-format
            key, which is what the round-trip matrix records a row under. Several rows may share
            one key — three OpenAPI write versions all come out of the ``openapi-3.1`` emitter.
        support: See :class:`VersionSupport`.
        note: One line on the boundary. Required for :attr:`VersionSupport.PARTIAL` and
            :attr:`VersionSupport.UNGATED`, because both are claims a reader cannot act on without
            the reason; optional for :attr:`VersionSupport.FULL`, which needs none.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    version: str = Field(
        min_length=1,
        description="How the format spells this version, or the authored surface an unversioned "
        "format's row covers.",
    )
    format_key: str = Field(
        min_length=1,
        description="The registry key that selects this version — a declared adapter format key "
        "on a read row, an emitter output-format key on a write row.",
    )
    support: VersionSupport = Field(
        description="Whether this version is a first-class target, reached through a stated "
        "projection, or not gated on a version marker at all.",
    )
    note: Optional[str] = Field(
        default=None,
        description="One line on the boundary — required whenever support is not ``full``.",
    )

    @model_validator(mode="after")
    def _note_required_when_qualified(self) -> "FormatVersion":
        """Reject a qualified claim with nothing to qualify it.

        ``partial`` and ``ungated`` are both statements a reader has to act on ("can I send my v2
        document?"), and neither is actionable without the reason. Enforcing it here means the
        table cannot grow a bare qualifier later.
        """
        if self.support is not VersionSupport.FULL and not (self.note or "").strip():
            raise ValueError(
                f"version {self.version!r} declares support={self.support.value!r} without a note "
                "explaining the boundary"
            )
        return self


class VersionCoverage(BaseModel):
    """One format's declared read and write version coverage (FMT-3.8).

    Attributes:
        declared: Whether this coverage was declared at all. ``False`` is the honest answer for a
            format key nothing here speaks for — one no adapter is registered under, or the
            internal acceptance adapter every published surface already excludes. An empty
            ``reads``/``writes`` pair would otherwise read as "reads nothing, writes nothing",
            which is a claim about the format rather than an absence of one.
        reads: The versions read, in the order a reader should see them (newest first).
        writes: The versions written, newest first. Empty for an import-only format.
        default_write: The :attr:`FormatVersion.version` an export produces when the caller states
            no preference. ``None`` exactly when :attr:`writes` is empty.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    declared: bool = Field(
        default=True,
        description="False for a format key nothing declares coverage for, whose versions are "
        "unknown rather than empty.",
    )
    # Tuples, not lists: a single :class:`VersionCoverage` instance is shared by every caller that
    # asks about a format — it is hung straight onto the capability entry rather than copied — so a
    # mutable sequence here would let one consumer's ``.reads.append(...)`` rewrite the declaration
    # for the whole process. ``frozen=True`` stops attribute assignment; only the container type
    # stops this.
    reads: Tuple[FormatVersion, ...] = Field(
        default=(),
        description="The versions this format is read at, newest first.",
    )
    writes: Tuple[FormatVersion, ...] = Field(
        default=(),
        description="The versions this format is written at, newest first. Empty when no emitter "
        "produces it.",
    )
    default_write: Optional[str] = Field(
        default=None,
        description="The version an export produces when the caller states no preference; null "
        "when the format is import-only.",
    )

    @model_validator(mode="after")
    def _coherent(self) -> "VersionCoverage":
        """Reject a coverage that contradicts itself.

        Three ways a hand-maintained table goes wrong, all caught at import time rather than in
        whichever consumer happens to render it first: a duplicated version, a default that names
        no declared write, and a writable format with no default (or an import-only one with one).
        """
        for label, rows in (("reads", self.reads), ("writes", self.writes)):
            versions = [row.version for row in rows]
            duplicates = sorted({v for v in versions if versions.count(v) > 1})
            if duplicates:
                raise ValueError(f"{label} declares {', '.join(duplicates)} more than once")
        written = {row.version for row in self.writes}
        if self.writes and self.default_write not in written:
            raise ValueError(
                f"default_write={self.default_write!r} is not one of the declared write versions "
                f"({', '.join(sorted(written)) or 'none'})"
            )
        if not self.writes and self.default_write is not None:
            raise ValueError("default_write is set on a format that declares no write versions")
        return self

    @property
    def read_format_keys(self) -> List[str]:
        """The distinct registry keys the read rows select, in declaration order."""
        return list(dict.fromkeys(row.format_key for row in self.reads))

    @property
    def write_format_keys(self) -> List[str]:
        """The distinct emitter output-format keys the write rows produce, in declaration order."""
        return list(dict.fromkeys(row.format_key for row in self.writes))


#: The coverage served for a format key no adapter is registered under. It declares nothing, and
#: says so — the same discipline :func:`app.format_capability_registry.capability_for` applies to a
#: retired adapter, for the same reason: a UI that cannot resolve a format falls back to "no
#: details", which is the dead end this registry exists to remove.
UNDECLARED_VERSION_COVERAGE = VersionCoverage(declared=False)


# ===========================================================================
# The declaration
# ===========================================================================

#: Shared wording for the two formats whose documents are Protobuf contracts.
_PROTO_SURFACE = "proto2 / proto3 (.proto)"

#: Per-format declared version coverage, keyed by import-source registry key.
#:
#: Every row's ``format_key`` is checked by the conformance suite: a read key must be one the
#: adapter declares *and* one at least one valid corpus fixture detects as, and a write key must
#: have a round-trip matrix row. Adding a version here without its fixture turns the suite red,
#: which is the whole point — this table states what is demonstrated, not what is intended.
_VERSION_COVERAGE: Dict[str, VersionCoverage] = {
    "apiblueprint": VersionCoverage(
        reads=[FormatVersion(version="1A", format_key="api-blueprint", support=VersionSupport.FULL)],
        writes=[FormatVersion(version="1A", format_key="apiblueprint", support=VersionSupport.FULL)],
        default_write="1A",
    ),
    "arazzo": VersionCoverage(
        reads=[
            FormatVersion(version="1.1.x", format_key="arazzo", support=VersionSupport.FULL),
            FormatVersion(version="1.0.x", format_key="arazzo", support=VersionSupport.FULL),
        ],
        writes=[
            FormatVersion(
                version="1.1.0",
                format_key="arazzo",
                support=VersionSupport.PARTIAL,
                note="Written only when the model carries an asynchronous source description, "
                "which 1.0 cannot express; every other model is written as 1.0.1.",
            ),
            FormatVersion(version="1.0.1", format_key="arazzo", support=VersionSupport.FULL),
        ],
        default_write="1.0.1",
    ),
    "asn1": VersionCoverage(
        reads=[
            FormatVersion(
                version="X.680 module syntax",
                format_key="asn1",
                support=VersionSupport.UNGATED,
                note="An ASN.1 module states no standard edition, so one module grammar is read "
                "and no X.680 revision is branched on.",
            )
        ],
        writes=[
            FormatVersion(
                version="X.680 module syntax",
                format_key="asn1",
                support=VersionSupport.UNGATED,
                note="The written module states no standard edition either, for the same reason.",
            )
        ],
        default_write="X.680 module syntax",
    ),
    "asyncapi": VersionCoverage(
        reads=[
            FormatVersion(version="3.1.0", format_key="asyncapi-3", support=VersionSupport.FULL),
            FormatVersion(version="3.0.0", format_key="asyncapi-3", support=VersionSupport.FULL),
            FormatVersion(version="2.6.0", format_key="asyncapi-2", support=VersionSupport.FULL),
        ],
        writes=[
            FormatVersion(version="3.1.0", format_key="asyncapi-3", support=VersionSupport.FULL),
            FormatVersion(
                version="2.6.0",
                format_key="asyncapi-3",
                support=VersionSupport.PARTIAL,
                note="Written by downgrading the 3.1 document (`asyncapi_version='2.6'`); 2.6 is "
                "the last and most capable 2.x minor, so it is the only 2.x target offered.",
            ),
        ],
        default_write="3.1.0",
    ),
    "avro": VersionCoverage(
        reads=[
            FormatVersion(
                version="Avro schema declaration (.avsc)",
                format_key="avro",
                support=VersionSupport.UNGATED,
                note="An Avro schema declaration carries no Avro release marker, so one grammar "
                "is read for every release.",
            ),
            FormatVersion(
                version="Avro IDL (.avdl)",
                format_key="avro-idl",
                support=VersionSupport.UNGATED,
                note="The IDL surface carries no version marker either; both surfaces build the "
                "same AST, so a protocol reads identically in either spelling.",
            ),
        ],
        writes=[
            FormatVersion(
                version="Avro schema declaration (.avsc)",
                format_key="avro",
                support=VersionSupport.UNGATED,
                note="The `.avdl` spelling is produced by the same writer through the "
                "`output_syntax` emit option, so the two cannot disagree about meaning.",
            )
        ],
        default_write="Avro schema declaration (.avsc)",
    ),
    "capnproto": VersionCoverage(
        reads=[
            FormatVersion(
                version="Cap'n Proto schema language",
                format_key="capnproto",
                support=VersionSupport.UNGATED,
                note="A `.capnp` schema declares no language version, so one grammar is read.",
            )
        ],
        writes=[
            FormatVersion(
                version="Cap'n Proto schema language",
                format_key="capnproto",
                support=VersionSupport.UNGATED,
                note="The written schema declares no language version either.",
            )
        ],
        default_write="Cap'n Proto schema language",
    ),
    "cloudevents": VersionCoverage(
        reads=[FormatVersion(version="1.0", format_key="cloudevents", support=VersionSupport.FULL)],
        writes=[FormatVersion(version="1.0", format_key="cloudevents", support=VersionSupport.FULL)],
        default_write="1.0",
    ),
    "cobolcopybook": VersionCoverage(
        reads=[
            FormatVersion(
                version="COBOL data-division record layout",
                format_key="cobolcopybook",
                support=VersionSupport.UNGATED,
                note="A copybook names no COBOL standard, so level numbers, PICTURE and USAGE are "
                "read without branching on a dialect.",
            )
        ],
        writes=[
            FormatVersion(
                version="COBOL data-division record layout",
                format_key="cobolcopybook",
                support=VersionSupport.UNGATED,
                note="The written layout names no COBOL standard either.",
            )
        ],
        default_write="COBOL data-division record layout",
    ),
    "connectrpc": VersionCoverage(
        reads=[
            FormatVersion(
                version=_PROTO_SURFACE,
                format_key="connectrpc",
                support=VersionSupport.UNGATED,
                note="Connect reuses the Protocol Buffers contract, so the readable surface is "
                "the `.proto` grammar rather than a Connect protocol version.",
            )
        ],
        writes=[
            FormatVersion(
                version="proto3 (.proto)",
                format_key="connectrpc",
                support=VersionSupport.UNGATED,
                note="Written as a standard proto3 bundle labelled for Connect; the Connect "
                "protocol version is a runtime concern the contract does not state.",
            )
        ],
        default_write="proto3 (.proto)",
    ),
    "corbaidl": VersionCoverage(
        reads=[
            FormatVersion(
                version="OMG IDL",
                format_key="corbaidl",
                support=VersionSupport.UNGATED,
                note="An `.idl` file declares no OMG IDL revision, so one grammar is read.",
            )
        ],
        writes=[
            FormatVersion(
                version="OMG IDL",
                format_key="corbaidl",
                support=VersionSupport.UNGATED,
                note="The written definition declares no OMG IDL revision either.",
            )
        ],
        default_write="OMG IDL",
    ),
    "discovery": VersionCoverage(
        reads=[
            FormatVersion(
                version="Discovery Document v1 (`rest`)",
                format_key="discovery",
                support=VersionSupport.FULL,
            )
        ],
    ),
    "edix12": VersionCoverage(
        reads=[
            FormatVersion(
                version="X12 interchange (004010, 005010, …)",
                format_key="edix12",
                support=VersionSupport.UNGATED,
                note="The control version the interchange declares (ISA12, GS08) is recorded, but "
                "the segment grammar read is the same for every release and no "
                "implementation-guide conformance is evaluated.",
            )
        ],
        writes=[
            FormatVersion(
                version="X12 interchange (004010, 005010, …)",
                format_key="edix12",
                support=VersionSupport.UNGATED,
                note="The written interchange carries whatever control version the model records; "
                "the emitter does not target a release of its own.",
            )
        ],
        default_write="X12 interchange (004010, 005010, …)",
    ),
    "fhir": VersionCoverage(
        reads=[FormatVersion(version="R4", format_key="fhir", support=VersionSupport.FULL)],
        writes=[FormatVersion(version="R4", format_key="fhir", support=VersionSupport.FULL)],
        default_write="R4",
    ),
    "fix": VersionCoverage(
        reads=[
            FormatVersion(
                version="tag=value message (any BeginString)",
                format_key="fix",
                support=VersionSupport.UNGATED,
                note="The session version the message declares (tag 8, `FIX.4.4`…) is recorded, "
                "but the tag=value grammar read is the same for every version and no data "
                "dictionary is applied.",
            )
        ],
        writes=[
            FormatVersion(
                version="tag=value message (any BeginString)",
                format_key="fix",
                support=VersionSupport.UNGATED,
                note="The written message carries whatever BeginString the model records.",
            )
        ],
        default_write="tag=value message (any BeginString)",
    ),
    "flatbuffers": VersionCoverage(
        reads=[
            FormatVersion(
                version="FlatBuffers schema (.fbs)",
                format_key="flatbuffers",
                support=VersionSupport.UNGATED,
                note="An `.fbs` schema declares no language version, so one grammar is read.",
            )
        ],
        writes=[
            FormatVersion(
                version="FlatBuffers schema (.fbs)",
                format_key="flatbuffers",
                support=VersionSupport.UNGATED,
                note="The written schema declares no language version either.",
            )
        ],
        default_write="FlatBuffers schema (.fbs)",
    ),
    "gateway-api": VersionCoverage(
        reads=[
            FormatVersion(version="v1", format_key="gateway-api", support=VersionSupport.FULL),
            FormatVersion(version="v1beta1", format_key="gateway-api", support=VersionSupport.FULL),
        ],
        writes=[
            FormatVersion(version="v1", format_key="gateway-api", support=VersionSupport.FULL),
            FormatVersion(
                version="v1beta1",
                format_key="gateway-api",
                support=VersionSupport.PARTIAL,
                note="Targeted with the `api_version` emit option; the document is otherwise "
                "identical to the v1 output, since HTTPRoute is unchanged between the two.",
            ),
        ],
        default_write="v1",
    ),
    "graphql": VersionCoverage(
        reads=[
            FormatVersion(
                version="SDL (October 2021)",
                format_key="graphql",
                support=VersionSupport.UNGATED,
                note="A GraphQL document carries no specification-edition marker; schemas written "
                "against earlier editions parse identically.",
            )
        ],
        writes=[
            FormatVersion(
                version="SDL (October 2021)",
                format_key="graphql",
                support=VersionSupport.UNGATED,
                note="The written SDL carries no specification-edition marker either.",
            )
        ],
        default_write="SDL (October 2021)",
    ),
    "grpc": VersionCoverage(
        reads=[
            FormatVersion(
                version="Editions 2023 / 2024",
                format_key="protobuf-editions",
                support=VersionSupport.FULL,
                note="Edition features are resolved down the lexical scope chain from the "
                "edition's own defaults table; six of the eight are modelled and the rest are "
                "recorded in provenance (FMT-3.7).",
            ),
            FormatVersion(
                version=_PROTO_SURFACE,
                format_key="protobuf",
                support=VersionSupport.FULL,
                note="Both syntaxes compile through `buf` to the same descriptor set, which is "
                "the artifact of record — the `.proto` text is never re-parsed here.",
            ),
        ],
        writes=[
            FormatVersion(
                version="proto3 (.proto)",
                format_key="proto3",
                support=VersionSupport.FULL,
            )
        ],
        default_write="proto3 (.proto)",
    ),
    "hl7v2": VersionCoverage(
        reads=[
            FormatVersion(
                version="2.x message (any MSH-12)",
                format_key="hl7v2",
                support=VersionSupport.UNGATED,
                note="The version the message declares (MSH-12) is recorded, but the segment / "
                "field grammar read is the same for every 2.x release and no message-profile "
                "conformance is evaluated.",
            )
        ],
        writes=[
            FormatVersion(
                version="2.x message (any MSH-12)",
                format_key="hl7v2",
                support=VersionSupport.UNGATED,
                note="The written message carries whatever version the model records.",
            )
        ],
        default_write="2.x message (any MSH-12)",
    ),
    "http-file": VersionCoverage(
        reads=[
            FormatVersion(
                version="`.http` / `.rest` request file and cURL snippet",
                format_key="http-file",
                support=VersionSupport.UNGATED,
                note="Neither the VS Code nor the JetBrains request-file dialect is versioned; "
                "both are read by one grammar and every construct is recorded as inferred.",
            )
        ],
        writes=[
            FormatVersion(
                version="`.http` / `.rest` request file and cURL snippet",
                format_key="http-file",
                support=VersionSupport.UNGATED,
                note="The `dialect` emit option chooses the VS Code or JetBrains spelling and "
                "`output='curl'` writes a shell script instead; none of the three is a version.",
            )
        ],
        default_write="`.http` / `.rest` request file and cURL snippet",
    ),
    "iso20022": VersionCoverage(
        reads=[
            FormatVersion(
                version="message XML (any message definition)",
                format_key="iso20022",
                support=VersionSupport.UNGATED,
                note="The message-definition identifier the document declares (`pain.001.001.09`) "
                "is recorded, but the reader does not branch on it and no message-definition "
                "schema is applied.",
            )
        ],
        writes=[
            FormatVersion(
                version="message XML (any message definition)",
                format_key="iso20022",
                support=VersionSupport.UNGATED,
                note="The written message carries whatever message-definition identifier the "
                "model records.",
            )
        ],
        default_write="message XML (any message definition)",
    ),
    "iso8583": VersionCoverage(
        reads=[
            FormatVersion(
                version="MTI + data-element field map (any release)",
                format_key="iso8583",
                support=VersionSupport.UNGATED,
                note="The release an MTI implies (1987, 1993, 2003) is not branched on; one "
                "field-map grammar is read and no institution's dialect is applied.",
            )
        ],
        writes=[
            FormatVersion(
                version="MTI + data-element field map (any release)",
                format_key="iso8583",
                support=VersionSupport.UNGATED,
                note="The written field map carries whatever MTI the model records.",
            )
        ],
        default_write="MTI + data-element field map (any release)",
    ),
    "json-schema": VersionCoverage(
        reads=[
            FormatVersion(
                version="2020-12",
                format_key="json-schema-2020-12",
                support=VersionSupport.FULL,
            ),
            FormatVersion(
                version="other `$schema` dialects (draft-07, 2019-09, …)",
                format_key="json-schema",
                support=VersionSupport.PARTIAL,
                note="Accepted and kept verbatim for later conversion; the canonical projection "
                "reads `$defs`/`definitions` and the root schema, so dialect-specific keywords "
                "survive in the retained source and nowhere else.",
            ),
        ],
        writes=[
            FormatVersion(version="2020-12", format_key="json-schema", support=VersionSupport.FULL)
        ],
        default_write="2020-12",
    ),
    "jtd": VersionCoverage(
        reads=[FormatVersion(version="RFC 8927", format_key="jtd", support=VersionSupport.FULL)],
        writes=[FormatVersion(version="RFC 8927", format_key="jtd", support=VersionSupport.FULL)],
        default_write="RFC 8927",
    ),
    "k8s-crd": VersionCoverage(
        reads=[
            FormatVersion(
                version="apiextensions.k8s.io/v1",
                format_key="k8s-crd",
                support=VersionSupport.FULL,
            ),
            FormatVersion(
                version="apiextensions.k8s.io/v1beta1",
                format_key="k8s-crd",
                support=VersionSupport.PARTIAL,
                note="Claimed by detection — every `apiextensions.k8s.io/*` group version is — and "
                "read through the v1 structural-schema path, which the deprecated v1beta1 "
                "`validation` block does not populate.",
            ),
        ],
        writes=[
            FormatVersion(
                version="apiextensions.k8s.io/v1",
                format_key="k8s-crd",
                support=VersionSupport.FULL,
            )
        ],
        default_write="apiextensions.k8s.io/v1",
    ),
    "kong": VersionCoverage(
        reads=[
            FormatVersion(version="deck `_format_version` 3.0", format_key="kong", support=VersionSupport.FULL),
            FormatVersion(version="deck `_format_version` 2.1", format_key="kong", support=VersionSupport.FULL),
            FormatVersion(version="deck `_format_version` 1.1", format_key="kong", support=VersionSupport.FULL),
        ],
        writes=[
            FormatVersion(version="deck `_format_version` 3.0", format_key="kong", support=VersionSupport.FULL),
            FormatVersion(
                version="deck `_format_version` 2.1",
                format_key="kong",
                support=VersionSupport.PARTIAL,
                note="Targeted with the `format_version` emit option; only the declared "
                "`_format_version` changes, since deck's document shape is the same across the "
                "three.",
            ),
            FormatVersion(
                version="deck `_format_version` 1.1",
                format_key="kong",
                support=VersionSupport.PARTIAL,
                note="Targeted with the `format_version` emit option, on the same terms as 2.1.",
            ),
        ],
        default_write="deck `_format_version` 3.0",
    ),
    "llm-tools": VersionCoverage(
        reads=[
            FormatVersion(
                version="OpenAI / Anthropic / bare tool array",
                format_key="llm-tools",
                support=VersionSupport.UNGATED,
                note="A tool array carries no version; the dialect is detected per tool and a "
                "mixed array is accepted, each tool recording the dialect it was read as.",
            )
        ],
        writes=[
            FormatVersion(
                version="OpenAI / Anthropic / bare tool array",
                format_key="llm-tools",
                support=VersionSupport.UNGATED,
                note="The `mode` emit option chooses the openai, anthropic or bare spelling; none "
                "of the three is a version.",
            )
        ],
        default_write="OpenAI / Anthropic / bare tool array",
    ),
    "mcp": VersionCoverage(
        reads=[
            FormatVersion(
                version="server manifest (any `protocolVersion`)",
                format_key="mcp",
                support=VersionSupport.UNGATED,
                note="The protocol version the manifest declares is recorded, but detection and "
                "normalization do not branch on it; the conformance pack states which "
                "specification revision its rules were written against.",
            )
        ],
    ),
    "odata": VersionCoverage(
        reads=[
            FormatVersion(
                version="4.0",
                format_key="odata",
                support=VersionSupport.FULL,
                note="Also the key a CSDL 1.x document resolves to — only majors 2 and 3 have "
                "version-scoped keys of their own.",
            ),
            FormatVersion(
                version="3.0",
                format_key="odata-v3",
                support=VersionSupport.PARTIAL,
                note="Read by projecting the v3 CSDL onto the v4 model (FMT-3.4): associations "
                "become navigation properties, and constructs v4 dropped survive only in the "
                "retained source.",
            ),
            FormatVersion(
                version="2.0",
                format_key="odata-v2",
                support=VersionSupport.PARTIAL,
                note="Read by projecting the v2 CSDL onto the v4 model, on the same terms as v3.",
            ),
        ],
        writes=[FormatVersion(version="4.0", format_key="odata", support=VersionSupport.FULL)],
        default_write="4.0",
    ),
    "oncrpc": VersionCoverage(
        reads=[
            FormatVersion(
                version="rpcgen (RPCL) definition",
                format_key="oncrpc",
                support=VersionSupport.UNGATED,
                note="A `.x` file declares no RPCL revision, so one grammar is read; the program "
                "and procedure version numbers it declares are data, not a format version.",
            )
        ],
        writes=[
            FormatVersion(
                version="rpcgen (RPCL) definition",
                format_key="oncrpc",
                support=VersionSupport.UNGATED,
                note="The written definition declares no RPCL revision either.",
            )
        ],
        default_write="rpcgen (RPCL) definition",
    ),
    "openapi": VersionCoverage(
        reads=[
            FormatVersion(version="3.2", format_key="openapi-3.2", support=VersionSupport.FULL),
            FormatVersion(version="3.1", format_key="openapi-3.1", support=VersionSupport.FULL),
            FormatVersion(version="3.0", format_key="openapi-3.0", support=VersionSupport.FULL),
            FormatVersion(version="2.0", format_key="swagger-2.0", support=VersionSupport.FULL),
            FormatVersion(
                version="1.2",
                format_key="swagger-1.2",
                support=VersionSupport.PARTIAL,
                note="Read by projecting the resource listing and its API declarations onto the "
                "2.0 path (FMT-3.6). Swagger 1.0 and 1.1 share the `swaggerVersion` marker but "
                "not the grammar, and are rejected as `FORMAT_VERSION_UNSUPPORTED` rather than "
                "mis-read as 1.2.",
            ),
        ],
        writes=[
            FormatVersion(version="3.1.0", format_key="openapi-3.1", support=VersionSupport.FULL),
            FormatVersion(
                version="3.0.3",
                format_key="openapi-3.1",
                support=VersionSupport.PARTIAL,
                note="Written by downgrading the 3.1 document (`openapi_version='3.0'`); what the "
                "3.0 dialect cannot carry is reported as a loss rather than dropped silently.",
            ),
            FormatVersion(
                version="2.0",
                format_key="openapi-3.1",
                support=VersionSupport.PARTIAL,
                note="Swagger 2.0, written by downgrading the 3.1 document "
                "(`openapi_version='2.0'`), on the same terms as 3.0.",
            ),
        ],
        default_write="3.1.0",
    ),
    "openrpc": VersionCoverage(
        reads=[
            FormatVersion(
                version="1.x",
                format_key="openrpc",
                support=VersionSupport.UNGATED,
                note="The `openrpc` version marker is recorded and re-emitted, but detection and "
                "normalization read one document grammar and do not branch on the minor.",
            )
        ],
        writes=[
            FormatVersion(
                version="1.x",
                format_key="openrpc",
                support=VersionSupport.UNGATED,
                note="The written document declares the version the model records, defaulting to "
                "1.2.6 when it records none.",
            )
        ],
        default_write="1.x",
    ),
    "postman": VersionCoverage(
        reads=[
            FormatVersion(version="Collection v2.1", format_key="postman", support=VersionSupport.FULL),
            FormatVersion(
                version="Collection v2.0",
                format_key="postman-2.0",
                support=VersionSupport.FULL,
                note="Both minors resolve to the same parser and normalizer (FMT-3.6); only the "
                "detection key differs, so the routing UI can say which minor it saw.",
            ),
        ],
        writes=[
            FormatVersion(version="Collection v2.1", format_key="postman", support=VersionSupport.FULL)
        ],
        default_write="Collection v2.1",
    ),
    "raml": VersionCoverage(
        reads=[FormatVersion(version="1.0", format_key="raml", support=VersionSupport.FULL)],
        writes=[
            FormatVersion(
                version="1.0",
                format_key="raml",
                support=VersionSupport.FULL,
                note="The `#%RAML` header states whatever version the model records, defaulting "
                "to 1.0.",
            )
        ],
        default_write="1.0",
    ),
    "cddl": VersionCoverage(
        reads=[
            FormatVersion(
                version="RFC 8610 (with RFC 9165 control operators)",
                format_key="cddl",
                support=VersionSupport.UNGATED,
                note="A CDDL grammar states no version of its own — RFC 8610 has had one "
                "grammar since 2019 and RFC 9165 only added control operators to it — so one "
                "reader covers every document, and a grammar that uses `.lt`/`.ne` reads "
                "identically to one that does not.",
            )
        ],
        writes=[
            FormatVersion(
                version="RFC 8610 (with RFC 9165 control operators)",
                format_key="cddl",
                support=VersionSupport.UNGATED,
                note="The written grammar states no version either, for the same reason; an "
                "RFC 9165 operator is written only when the source used one.",
            )
        ],
        default_write="RFC 8610 (with RFC 9165 control operators)",
    ),
    "arrow": VersionCoverage(
        reads=[
            FormatVersion(
                version="Arrow columnar format 1.x (IPC metadata V4/V5)",
                format_key="arrow",
                support=VersionSupport.UNGATED,
                note="An Arrow schema carries no version the reader branches on. The columnar "
                "format's releases add *types*, not a schema dialect — a field naming a type "
                "this reader does not know is rejected as a semantic error rather than routed "
                "to a second grammar — and the IPC metadata version is resolved inside the "
                "Flatbuffer reader. The JSON integration form, a binary IPC stream or file, and "
                "a Flight `GetSchema` reply are three serializations of one schema, not three "
                "versions of it.",
            )
        ],
        writes=[],
        default_write=None,
    ),
    "odcs": VersionCoverage(
        reads=[
            FormatVersion(
                version="ODCS v3.x (v3.0, v3.1)",
                format_key="odcs",
                support=VersionSupport.FULL,
                note="v3.0 and v3.1 are one document shape — 3.1 widened the quality "
                "vocabulary and allowed `customProperties` on more nodes, both of which are "
                "carried verbatim — so one reader covers the line and a 3.0 contract reads "
                "identically to a 3.1 one. The v2.2.x line is a *different* document (a "
                "`quantumName` with `dataset[].columns[]`) and is rejected as "
                "`FORMAT_VERSION_UNSUPPORTED` with the renames named, rather than parsed.",
            )
        ],
        writes=[
            FormatVersion(
                version="ODCS v3.1.0",
                format_key="odcs",
                support=VersionSupport.FULL,
                note="The default. Emitted contracts are validated against the published "
                "v3.1.0 JSON Schema, which this service ships and runs offline.",
            ),
            FormatVersion(
                version="ODCS v3.0.2",
                format_key="odcs",
                support=VersionSupport.FULL,
                note="Written when the imported contract declared a v3.0.x version, or when "
                "the caller asks for it. The two lines are *not* interchangeable documents: "
                "v3.1 turned `team` from an array of members into an object and closed "
                "`quality` against the v3.0 `rule:` spelling, so a v3.0 contract is written "
                "back — and validated — as v3.0.",
            ),
        ],
        default_write="ODCS v3.1.0",
    ),
    "kafka-connect": VersionCoverage(
        reads=[
            FormatVersion(
                version="Kafka Connect schema form",
                format_key="kafka-connect",
                support=VersionSupport.UNGATED,
                note="Connect's schema form carries no dialect version the reader branches "
                "on — a schema's integer `version` is the revision a registry assigned to that "
                "subject, not a spelling of the format — so one grammar is read for every "
                "Connect release. The `{schema, payload}` converter envelope and a pipeline "
                "file set are two packagings of the same schema, not two versions of it.",
            )
        ],
        writes=[
            FormatVersion(
                version="Kafka Connect schema form",
                format_key="kafka-connect",
                support=VersionSupport.UNGATED,
                note="The writer produces the same one grammar the reader accepts, and every "
                "emitted document is read back through that reader before it leaves the "
                "emitter.",
            )
        ],
        default_write="Kafka Connect schema form",
    ),
    "dbt": VersionCoverage(
        reads=[
            FormatVersion(
                version="dbt properties `version: 2`",
                format_key="dbt",
                support=VersionSupport.FULL,
                note="The only properties schema dbt has published since 0.21, and the one "
                "every `schema.yml` in the wild declares. A file that omits `version:` is "
                "read as 2, exactly as dbt itself does; a file that declares anything else "
                "is rejected as `FORMAT_VERSION_UNSUPPORTED` rather than mis-read, because "
                "the v1 shape spelled models as a mapping keyed by name.",
            ),
            FormatVersion(
                version="dbt manifest v7-v12 (dbt 1.0 - 1.9)",
                format_key="dbt",
                support=VersionSupport.FULL,
                note="v7 is the first manifest with the node shape this reader walks — "
                "`nodes` keyed by `unique_id`, `columns` as a mapping, and every test "
                "hoisted into its own node with `test_metadata`. Every schema version since "
                "has *added* keys, which are carried verbatim, so one reader covers the "
                "line and a v7 manifest reads identically to a v12 one. A manifest outside "
                "the line is rejected by version with the `dbt compile` remediation named.",
            ),
        ],
        writes=[],
        default_write=None,
    ),
    "dtd": VersionCoverage(
        reads=[
            FormatVersion(
                version="XML 1.0 DTD",
                format_key="dtd",
                support=VersionSupport.UNGATED,
                note="A DTD carries no version marker of its own — it is part of the XML 1.0 "
                "grammar, and XML 1.1 did not change it — so one reader covers every "
                "document. An external subset, an internal subset and a modular set "
                "composed through parameter entities are three placements of one grammar, "
                "not three versions of it.",
            )
        ],
        writes=[],
        default_write=None,
    ),
    "relaxng": VersionCoverage(
        reads=[
            FormatVersion(
                version="RELAX NG XML syntax (.rng)",
                format_key="relaxng",
                support=VersionSupport.UNGATED,
                note="RELAX NG has had one specification since 2001 and a grammar carries no "
                "release marker, so one reader covers every document.",
            ),
            FormatVersion(
                version="RELAX NG compact syntax (.rnc)",
                format_key="relaxng-compact",
                support=VersionSupport.UNGATED,
                note="The compact syntax is a second spelling of the same language, read by a "
                "second front-end onto the same pattern algebra, so a grammar reads identically "
                "in either spelling.",
            ),
        ],
        writes=[],
        default_write=None,
    ),
    "smithy": VersionCoverage(
        reads=[FormatVersion(version="2.0", format_key="smithy", support=VersionSupport.FULL)],
        writes=[
            FormatVersion(
                version="2.0",
                format_key="smithy",
                support=VersionSupport.FULL,
                note="Written as the `$version` control statement; the `smithy_version` emit "
                "option can state another, which is not validated against the emitted grammar.",
            )
        ],
        default_write="2.0",
    ),
    "thrift": VersionCoverage(
        reads=[
            FormatVersion(
                version="Thrift IDL",
                format_key="thrift",
                support=VersionSupport.UNGATED,
                note="A `.thrift` file declares no compiler release, so one grammar is read.",
            )
        ],
        writes=[
            FormatVersion(
                version="Thrift IDL",
                format_key="thrift",
                support=VersionSupport.UNGATED,
                note="The written document declares no compiler release either.",
            )
        ],
        default_write="Thrift IDL",
    ),
    "typespec": VersionCoverage(
        reads=[
            FormatVersion(
                version="TypeSpec (.tsp)",
                format_key="typespec",
                support=VersionSupport.UNGATED,
                note="A `.tsp` file declares no language version, so one grammar is read and no "
                "compiler release is targeted.",
            )
        ],
        writes=[
            FormatVersion(
                version="TypeSpec (.tsp)",
                format_key="typespec",
                support=VersionSupport.UNGATED,
                note="The written definition declares no language version either.",
            )
        ],
        default_write="TypeSpec (.tsp)",
    ),
    "wadl": VersionCoverage(
        reads=[FormatVersion(version="2009-02-09", format_key="wadl", support=VersionSupport.FULL)],
        writes=[FormatVersion(version="2009-02-09", format_key="wadl", support=VersionSupport.FULL)],
        default_write="2009-02-09",
    ),
    "wit": VersionCoverage(
        reads=[
            FormatVersion(
                version="Component Model WIT (0.2 surface)",
                format_key="wit",
                support=VersionSupport.FULL,
                note="A WIT package declares its own package version, not a WIT language version; "
                "0.2 names the Component Model surface the parser covers.",
            )
        ],
        writes=[
            FormatVersion(
                version="Component Model WIT (0.2 surface)",
                format_key="wit",
                support=VersionSupport.FULL,
            )
        ],
        default_write="Component Model WIT (0.2 surface)",
    ),
    "wsdl": VersionCoverage(
        reads=[
            FormatVersion(version="1.1", format_key="wsdl", support=VersionSupport.FULL),
            FormatVersion(version="2.0", format_key="wsdl-2.0", support=VersionSupport.FULL),
        ],
        writes=[
            FormatVersion(
                version="1.1",
                format_key="wsdl",
                support=VersionSupport.FULL,
                note="WSDL 2.0 output is not implemented (#4182), so 2.0 is import-only.",
            )
        ],
        default_write="1.1",
    ),
    "xmlrpc": VersionCoverage(
        reads=[FormatVersion(version="1.0", format_key="xmlrpc", support=VersionSupport.FULL)],
        writes=[FormatVersion(version="1.0", format_key="xmlrpc", support=VersionSupport.FULL)],
        default_write="1.0",
    ),
    "xsd": VersionCoverage(
        reads=[
            FormatVersion(
                version="1.0 / 1.1",
                format_key="xsd",
                support=VersionSupport.UNGATED,
                note="Both XSD versions share one namespace and no `vc:minVersion` gate is read, "
                "so a 1.1 document is accepted; its 1.1-only constructs (assertions, conditional "
                "type assignment) are not modelled.",
            )
        ],
        writes=[
            FormatVersion(
                version="1.0",
                format_key="xsd",
                support=VersionSupport.FULL,
                note="Only 1.0 constructs are written, so the output is valid under either "
                "version's processor.",
            )
        ],
        default_write="1.0",
    ),
    "zosconnect": VersionCoverage(
        reads=[
            FormatVersion(
                version="API requester / provider descriptor",
                format_key="zosconnect",
                support=VersionSupport.UNGATED,
                note="A z/OS Connect descriptor states no product version, so one document shape "
                "is read for both the requester and the provider flavour.",
            )
        ],
        writes=[
            FormatVersion(
                version="API requester / provider descriptor",
                format_key="zosconnect",
                support=VersionSupport.UNGATED,
                note="The written descriptor states no product version either.",
            )
        ],
        default_write="API requester / provider descriptor",
    ),
}


def version_coverage_for(format_key: str) -> VersionCoverage:
    """Return the declared version coverage for ``format_key`` — always, for any key.

    Mirrors :func:`app.format_capability_registry.capability_for`: there is no input for which
    this returns nothing, because "the table had no answer" is the dead end a reader cannot act
    on. A key with no declaration resolves to :data:`UNDECLARED_VERSION_COVERAGE`, which says so.

    Args:
        format_key: An import-source registry key (already resolved through any alias).

    Returns:
        The format's :class:`VersionCoverage`, or :data:`UNDECLARED_VERSION_COVERAGE`.
    """
    return _VERSION_COVERAGE.get((format_key or "").strip().lower(), UNDECLARED_VERSION_COVERAGE)


def declared_version_coverage() -> Dict[str, VersionCoverage]:
    """Return every declaration, keyed by import-source registry key.

    A shallow copy, so a caller (the conformance suite, a report generator) cannot mutate the
    table it is checking.

    Returns:
        Registry key → :class:`VersionCoverage`, in declaration order.
    """
    return dict(_VERSION_COVERAGE)
