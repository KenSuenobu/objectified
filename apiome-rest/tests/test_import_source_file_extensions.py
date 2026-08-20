"""Unit tests for the import-source ``file_extensions`` SPI declaration (FMT-1.1, #5412).

The engine registers 43 adapters, but every file picker used to carry its own
hand-maintained ten-entry ``accept`` array, so thirty-three working formats were
built and invisible. The fix is to make the *registry* the single source of truth:
each adapter declares the extensions its documents carry, the descriptor publishes
them on ``GET /v1/import/sources``, and the pickers derive their ``accept`` from
that list instead of restating it.

These tests pin the half of that contract that lives server-side:

* every adapter that can take a file declares at least one extension, or is
  recorded in :data:`EXTENSIONLESS_JUSTIFICATIONS` with the reason why not;
* the declarations are well-formed (lower-case, dot-prefixed, de-duplicated) and
  the archive suffixes are folded in for fileset adapters automatically;
* the formats the ticket named as unreachable are now each claimed by some
  adapter's declared extensions.
"""

from __future__ import annotations

from typing import Dict, List

import pytest

from app.archive_intake import ARCHIVE_SUFFIXES
from app.canonical_model import ApiParadigm
from app.import_source import (
    _REGISTRY,
    ImportSource,
    ImportSourceDescriptor,
    InputKind,
    available_import_sources,
    describe_import_sources,
    get_import_source,
    load_builtin_import_sources,
)
from app.proto_descriptor import DESCRIPTOR_SET_SUFFIXES


def builtin_descriptors() -> List[ImportSourceDescriptor]:
    """Return the descriptors of the **shipped** adapters, sorted by key.

    Sibling tests register throwaway adapters into the process-wide ``_REGISTRY`` and several do not
    remove them, so :func:`describe_import_sources` is order-dependent. A built-in adapter's class
    is defined in an ``app.*`` module while a test's throwaway is defined in ``tests.*``, which is
    what separates the two — and scoping to ``app.*`` is what these assertions actually mean: they
    are a rule about adapters Apiome ships, not about a fixture that lived for one test.
    """
    load_builtin_import_sources()
    return [
        cls.descriptor()
        for _key, cls in sorted(_REGISTRY.items())
        if cls.__module__.startswith("app.")
    ]

# ===========================================================================
# Justifications
# ===========================================================================

#: Adapters that accept :attr:`InputKind.FILE` yet deliberately declare **no**
#: extension, each with the reason. Empty today: every file-accepting built-in has
#: a conventional suffix. A future adapter for a genuinely extension-less format
#: (a bare wire capture, say) belongs here rather than silently declaring nothing —
#: an empty tuple must always be a decision on record, never an oversight.
EXTENSIONLESS_JUSTIFICATIONS: Dict[str, str] = {}


# ===========================================================================
# Every adapter declares, or justifies not declaring
# ===========================================================================


def test_every_file_accepting_adapter_declares_an_extension() -> None:
    """The acceptance criterion: declare at least one extension, or justify it.

    An adapter that cannot take a file at all (``sample`` is paste-only) needs no
    justification — it never reaches a picker — so the rule is scoped to adapters
    that actually accept :attr:`InputKind.FILE`.
    """
    missing: List[str] = []
    for descriptor in builtin_descriptors():
        if InputKind.FILE not in descriptor.input_kinds:
            continue
        if descriptor.file_extensions:
            continue
        if descriptor.key in EXTENSIONLESS_JUSTIFICATIONS:
            continue
        missing.append(descriptor.key)

    assert not missing, (
        "these adapters accept a file but declare no `file_extensions`, so no picker "
        f"can offer them: {sorted(missing)}. Declare the format's suffixes on the "
        "adapter, or record the reason in EXTENSIONLESS_JUSTIFICATIONS."
    )


def test_justifications_only_name_real_extensionless_adapters() -> None:
    """A stale justification is as bad as a missing one — it hides a real gap."""
    descriptors = {d.key: d for d in builtin_descriptors()}
    for key, reason in EXTENSIONLESS_JUSTIFICATIONS.items():
        assert key in descriptors, f"justification names unregistered adapter {key!r}"
        assert reason.strip(), f"justification for {key!r} is empty"
        assert not descriptors[key].file_extensions, (
            f"{key!r} is justified as extension-less but now declares "
            f"{descriptors[key].file_extensions}; drop the stale justification."
        )


def test_paste_only_adapter_declares_nothing() -> None:
    """``sample`` is paste-only, so it has no filename to accept and declares none."""
    sample = {d.key: d for d in builtin_descriptors()}["sample"]
    assert InputKind.FILE not in sample.input_kinds
    assert sample.file_extensions == []


# ===========================================================================
# Declarations are well-formed
# ===========================================================================


def test_declared_extensions_are_normalized_and_unique() -> None:
    """Lower-case, dot-prefixed, no duplicates — a picker joins these verbatim."""
    for descriptor in builtin_descriptors():
        exts = descriptor.file_extensions
        assert len(exts) == len(set(exts)), f"{descriptor.key}: duplicate extensions in {exts}"
        for ext in exts:
            assert ext.startswith("."), f"{descriptor.key}: {ext!r} is missing its leading dot"
            assert ext == ext.lower(), f"{descriptor.key}: {ext!r} is not lower-case"
            assert ext.strip() == ext, f"{descriptor.key}: {ext!r} has surrounding whitespace"
            assert len(ext) > 1, f"{descriptor.key}: {ext!r} is a bare dot"


def test_fileset_adapters_carry_the_archive_suffixes() -> None:
    """An archive is a legitimate way to hand a fileset adapter its documents.

    The suffixes are appended by the descriptor, not respelled per adapter, so
    adding an archive container server-side widens every fileset picker at once.
    """
    for descriptor in builtin_descriptors():
        if InputKind.FILESET not in descriptor.input_kinds:
            assert not set(ARCHIVE_SUFFIXES) & set(descriptor.file_extensions), (
                f"{descriptor.key} does not take a fileset but lists archive suffixes"
            )
            continue
        for suffix in ARCHIVE_SUFFIXES:
            assert suffix in descriptor.file_extensions, (
                f"{descriptor.key} accepts a fileset but its picker would not offer {suffix}"
            )


def test_archive_suffixes_come_last_so_the_canonical_extension_leads() -> None:
    """Declaration order is preserved; only the archive suffixes are appended."""
    graphql = {d.key: d for d in builtin_descriptors()}["graphql"]
    assert graphql.file_extensions[:3] == [".graphql", ".gql", ".graphqls"]
    assert graphql.file_extensions[3:] == list(ARCHIVE_SUFFIXES)


def test_single_entry_declaration_written_without_a_comma_is_not_shredded() -> None:
    """``(".foo")`` is a *str*; iterating it would yield one bogus extension per char.

    The SPI treats a bare string as the single extension it was plainly meant to
    be, so a missing trailing comma cannot quietly poison a picker's accept list.
    """

    class _StringDeclaration(ImportSource):
        key = "fmt11-string-declaration"
        label = "String declaration"
        description = "Declares its single extension without a trailing comma."
        paradigm = ApiParadigm.REST
        input_kinds = (InputKind.FILE,)
        file_extensions = ".capnp"  # type: ignore[assignment]  # deliberately wrong

    assert _StringDeclaration.declared_file_extensions() == (".capnp",)


def test_declarations_are_normalized_on_the_way_out() -> None:
    """Casing, whitespace, a missing dot and a repeat are all cleaned up."""

    class _MessyDeclaration(ImportSource):
        key = "fmt11-messy-declaration"
        label = "Messy declaration"
        description = "Declares its extensions untidily."
        paradigm = ApiParadigm.REST
        input_kinds = (InputKind.FILE,)
        file_extensions = ("  .TSP ", "cadl", ".tsp", "")

    assert _MessyDeclaration.declared_file_extensions() == (".tsp", ".cadl")


# ===========================================================================
# The formats the ticket named are reachable
# ===========================================================================


#: Every extension #5412 called out as unbrowsable, and the adapter that owns it.
TICKETED_EXTENSIONS: Dict[str, str] = {
    ".tsp": "typespec",
    ".fbs": "flatbuffers",
    ".capnp": "capnproto",
    ".idl": "corbaidl",
    ".x": "oncrpc",
    ".wsdl": "wsdl",
    ".xsd": "xsd",
    ".edmx": "odata",
    ".cpy": "cobolcopybook",
    ".cbl": "cobolcopybook",
    ".edi": "edix12",
    ".hl7": "hl7v2",
    ".asn1": "asn1",
    ".wit": "wit",
    ".smithy": "smithy",
    ".apib": "apiblueprint",
    ".http": "http-file",
    ".rest": "http-file",
}


@pytest.mark.parametrize(("extension", "key"), sorted(TICKETED_EXTENSIONS.items()))
def test_ticketed_extension_is_declared_by_its_adapter(extension: str, key: str) -> None:
    load_builtin_import_sources()
    descriptors = {d.key: d for d in describe_import_sources()}
    assert key in descriptors, f"{key} is not registered"
    assert extension in descriptors[key].file_extensions


def test_registry_accept_list_covers_far_more_than_the_old_ten() -> None:
    """The whole point: the union is no longer a ten-entry hand-maintained array."""
    union = {ext for d in builtin_descriptors() for ext in d.file_extensions}
    # The list the Projects importer used to hard-code, all still present.
    previously_hard_coded = {
        ".yaml", ".yml", ".json", ".zip", ".graphql",
        ".gql", ".raml", ".proto", ".avsc", ".thrift",
    }
    assert previously_hard_coded <= union
    assert len(union) > 3 * len(previously_hard_coded)


# ===========================================================================
# Constants are referenced, not respelled
# ===========================================================================


def test_grpc_reuses_the_descriptor_set_suffix_constant() -> None:
    """The picker and ``is_descriptor_set_filename`` must not drift apart."""
    grpc = {d.key: d for d in builtin_descriptors()}["grpc"]
    for suffix in DESCRIPTOR_SET_SUFFIXES:
        assert suffix in grpc.file_extensions


def test_every_registered_key_has_a_descriptor_with_the_new_field() -> None:
    """No adapter is left behind: the field is on all 43, not just the edited ones."""
    load_builtin_import_sources()
    keys = available_import_sources()
    descriptors = {d.key: d for d in describe_import_sources()}
    assert set(descriptors) == set(keys)
    for key in keys:
        adapter = get_import_source(key)
        assert adapter is not None
        assert isinstance(descriptors[key].file_extensions, list)
