"""Where a data contract's governance facts live — FMT-5.5 (#5443).

A data contract answers a different set of questions from an API description: who owns
this dataset, what does it promise, how fresh is it, how long is it kept, which columns
carry personal data, what identifies a row, and where is it actually served. Every one of
those is *stated* by the formats Apiome reads — but each format states it in its own
place, under its own key, and the canonical model has no native facet for any of them.
They survive in ``extras`` under each reader's documented namespace, and this module is
the one place that knows where.

**Why the knowledge lives here rather than in the rules.** The FMT-5.5 rule pack asks
questions like "is there a named owner?". If each rule reached into ``odcs_team`` *and*
``dbt_meta`` *and* ``connect_*`` itself, adding a sixth data format would mean editing
nine rules. Instead the pack asks :class:`ContractFacts`, and a new data-schema reader
teaches this module alone.

**The shared quality namespace is what makes one of these questions answerable at all.**
FMT-5.1 defined ``extras['odcs_quality']`` and FMT-5.4 projected dbt's data tests into the
same key in the same ODCS rule shape, so "does this column have a declared quality check?"
is one lookup for both formats rather than two. That dependency is the reason this ticket
is sequenced after 5.1.

Everything here is **read-only, total and defensive**: a fact reader is handed whatever a
normalizer happened to produce, so every accessor tolerates a missing key, a wrong type, or
a ``None``, and returns an empty result rather than raising. A lint pass must never fail
because a document was odd.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, List, Mapping, Optional, Sequence, Tuple

from .canonical_model import CanonicalApi, CanonicalField, Type

__all__ = [
    "CONTRACT_FORMATS",
    "SCHEMA_ONLY_FORMATS",
    "CLASSIFICATION_EXTRA_KEYS",
    "CLASSIFICATION_LABEL_KEYS",
    "FRESHNESS_TOKENS",
    "IDENTITY_EXTRA_KEYS",
    "OWNER_BEARING_EXTRA_KEYS",
    "OWNER_EXTRA_KEYS",
    "QUALITY_EXTRA_KEY",
    "RETENTION_TOKENS",
    "SERVER_EXTRA_KEYS",
    "SLA_EXTRA_KEYS",
    "ContractFacts",
    "describes_a_data_contract",
    "read_contract_facts",
]

# ---------------------------------------------------------------------------
# Which formats are data *contracts*, and which are only data *schemas*
# ---------------------------------------------------------------------------

#: Source formats that can state a data contract's governance half.
#:
#: A data contract states who owns a dataset, what it promises, how long it is kept and
#: where it is served. Two of the formats Apiome reads have syntax for that; the rest of the
#: ``data_schema`` paradigm does not, and the difference is what this set exists to record.
CONTRACT_FORMATS: frozenset = frozenset(
    {
        # ODCS is a data contract by definition: `team[]`, `slaProperties[]`, `servers[]`,
        # `support[]`, `quality[]`, per-property `classification`, `status`, `version`.
        "odcs",
        # dbt states the same facts in its own places: `meta.owner` and an exposure `owner`,
        # a source `freshness` block, `config` (including retention on some adapters), the
        # database/schema/alias a resource materializes to, and data tests.
        "dbt",
    }
)

#: Source formats that describe a dataset's **shape** and nothing else.
#:
#: Avro, XSD, RELAX NG, ASN.1, CDDL, DTD, FlatBuffers, JSON Schema, JTD, Arrow, a Kafka
#: Connect schema, a COBOL copybook and the EDI/HL7/ISO wire grammars are schema languages:
#: there is no place in any of them to write down an owner, a service level or a retention
#: window. Asking one of them for those facts reports a **capability limit of the format** as
#: a defect of the document — the exact mistake the declared-limits ledger exists elsewhere
#: in this service to avoid — so the FMT-5.5 pack self-gates to nothing for them, exactly as
#: the IXH-5.4 example-conformance pack self-gates on an artifact with no walkable document.
#:
#: Listed rather than derived so a *new* data-schema reader has to be triaged into one set or
#: the other: ``test_every_data_schema_format_is_classified`` fails until it is.
SCHEMA_ONLY_FORMATS: frozenset = frozenset(
    {
        "arrow",
        "asn1",
        "avro",
        "cddl",
        "cobolcopybook",
        "dtd",
        "edix12",
        "fix",
        "flatbuffers",
        "hl7v2",
        "iso20022",
        "iso8583",
        "json-schema",
        "jtd",
        "k8s-crd",
        "kafka-connect",
        "relaxng",
        "sample",
        "xsd",
    }
)


def describes_a_data_contract(api: CanonicalApi) -> bool:
    """Whether ``api`` came from a format that can state a data contract's governance half.

    This is the FMT-5.5 pack's gate. A ``data_schema`` artifact from a schema *language* is
    not a worse data contract than an ODCS document — it is not a data contract at all, and
    scoring it as one would put "no owner declared" on every Avro record in every catalog.

    The check is an **allow-list**: only a format declared in :data:`CONTRACT_FORMATS` is
    scored. That is the safe default in both directions. The paradigm is a property of the
    *document*, not only of the adapter — a WIT file that declares types and no interfaces
    normalizes to ``data_schema`` even though WIT's adapter does not — so a deny-list would
    quietly rope in artifacts nobody triaged. The pressure to triage a genuinely new contract
    format comes from ``test_every_data_schema_format_is_classified`` instead, which fails
    until a new data-schema reader is placed in one set or the other.

    Args:
        api: The canonical artifact.

    Returns:
        ``True`` when the pack should score this artifact.
    """
    return str(api.format or "").strip().lower() in CONTRACT_FORMATS


# ---------------------------------------------------------------------------
# Where each fact lives, per reader namespace
# ---------------------------------------------------------------------------

#: The shared data-quality namespace. One key, two writers: FMT-5.1's ODCS reader carries a
#: contract's ``quality[]`` rules here verbatim, and FMT-5.4's dbt reader projects the data
#: tests it cannot turn into constraints into the same key in the same ODCS ``type: custom``
#: rule shape. A third data format joins by writing here too, and every rule below keeps
#: working unchanged.
QUALITY_EXTRA_KEY = "odcs_quality"

#: Root-level extras keys whose entries **are** ownership entries. ``odcs_team`` is the
#: contract's own ownership block and ``odcs_roles`` names the access roles and their
#: approvers; the bare ``owner``/``owners``/``contacts`` spellings are the generic escape
#: hatch a future reader can use without editing this module.
OWNER_EXTRA_KEYS: Tuple[str, ...] = (
    "odcs_team",
    "odcs_roles",
    "owner",
    "owners",
    "contacts",
)

#: Root-level extras keys whose entries *carry* an ownership block under an ``owner`` key
#: rather than being one. A dbt exposure is the case: it names a downstream dashboard and
#: **may** name who owns it, so only the ``owner`` sub-block counts. Reading the exposure
#: itself as an owner would let an exposure with no owner satisfy the rule on the strength of
#: having a name.
OWNER_BEARING_EXTRA_KEYS: Tuple[str, ...] = ("dbt_exposures",)

#: Root-level extras keys stating a **service level**: latency, freshness, availability,
#: retention windows.
SLA_EXTRA_KEYS: Tuple[str, ...] = ("odcs_sla_properties", "sla", "sla_properties")

#: Extras keys stating **where the dataset is served from**, at root or on a type. A dbt
#: resource's ``dbt_relation`` (database / schema / alias / identifier) is the warehouse
#: location the same way an ODCS ``servers[]`` entry is the serving infrastructure.
SERVER_EXTRA_KEYS: Tuple[str, ...] = ("odcs_servers", "servers", "dbt_relation")

#: Field-level extras keys declaring **row identity** — a primary key or a uniqueness
#: constraint. ODCS spells it ``odcs_key``; dbt spells it ``dbt_key`` plus a model-contract
#: ``dbt_constraints`` entry.
IDENTITY_EXTRA_KEYS: Tuple[str, ...] = ("odcs_key", "dbt_key")

#: Field-level extras keys whose mere presence **is** a governance classification: a
#: confidentiality label, or a critical-data-element marker.
CLASSIFICATION_EXTRA_KEYS: Tuple[str, ...] = (
    "odcs_classification",
    "odcs_critical_data_element",
)

#: Field-level extras keys that *may* carry a classification but are free-form, so presence
#: alone proves nothing: a publisher's ``meta`` bag and the selection ``tags`` dbt uses for
#: `--select tag:nightly`. These count only when they actually name a personal-data marker
#: (:data:`_PII_TOKENS`) — a `nightly` tag is not a classification.
CLASSIFICATION_LABEL_KEYS: Tuple[str, ...] = ("dbt_meta", "dbt_tags", "odcs_tags")

#: Substrings that mark an SLA/config entry as a **freshness** promise. Matched
#: case-insensitively against an entry's property name and its keys, because the four
#: formats spell the same promise as ``frequency``, ``latency``, ``freshness`` and
#: ``warn_after``.
FRESHNESS_TOKENS: Tuple[str, ...] = (
    "fresh",
    "latency",
    "frequency",
    "warn_after",
    "error_after",
    "loaded_at",
    "timeliness",
    "recency",
)

#: Substrings that mark an SLA/config entry as a **retention** promise.
RETENTION_TOKENS: Tuple[str, ...] = ("retention", "retain", "expiry", "ttl", "time_to_live")

#: Extras keys naming the model-contract constraint list, which is where dbt states a
#: ``primary_key``/``unique`` constraint at the *resource* level rather than on a column.
_CONSTRAINT_EXTRA_KEYS: Tuple[str, ...] = ("dbt_constraints",)

#: Constraint ``type`` values that declare row identity.
_IDENTITY_CONSTRAINT_TYPES = frozenset({"primary_key", "unique"})

#: ``meta``/``tags`` values that read as a personal-data marker rather than a free label.
_PII_TOKENS: Tuple[str, ...] = ("pii", "personal", "sensitive", "gdpr", "phi", "confidential")


# ---------------------------------------------------------------------------
# Defensive readers
# ---------------------------------------------------------------------------


def _extras(node: Any) -> Mapping[str, Any]:
    """Return a node's ``extras`` mapping, or an empty one.

    Args:
        node: Any canonical entity, or ``None``.

    Returns:
        The extras mapping when the node has a usable one; otherwise ``{}``.
    """
    extras = getattr(node, "extras", None)
    return extras if isinstance(extras, Mapping) else {}


def _entries(value: Any) -> List[Any]:
    """Read a value as a list of entries, whatever shape the source used.

    A governance block is a list in one format, a mapping in another, and occasionally a
    bare scalar. Reading all three the same way is what keeps the rules format-agnostic.

    Args:
        value: The declared value.

    Returns:
        The entries: a list as-is, a mapping's values, a non-empty scalar as one entry, and
        an empty list for ``None``/``""``/``{}``/``[]``.
    """
    if value is None:
        return []
    if isinstance(value, Mapping):
        return [value] if value else []
    if isinstance(value, (list, tuple)):
        return [entry for entry in value if entry is not None]
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [value]


def _has_text(value: Any) -> bool:
    """Whether ``value`` is a non-blank string."""
    return isinstance(value, str) and value.strip() != ""


def _mentions(value: Any, tokens: Sequence[str]) -> bool:
    """Whether any of ``tokens`` appears in ``value``'s text, case-insensitively.

    Walks a nested mapping/list so a token stated as a *key* (``warn_after``) counts the
    same as one stated as a *value* (``"freshness"``). Depth is bounded because the blocks
    involved are small and hand-written; a pathological one simply stops contributing.

    Args:
        value: The declared value, of any shape.
        tokens: Lower-case substrings to look for.

    Returns:
        ``True`` when any token matches.
    """
    return _mentions_at(value, tokens, depth=0)


def _mentions_at(value: Any, tokens: Sequence[str], *, depth: int) -> bool:
    """Depth-bounded worker for :func:`_mentions`."""
    if depth > 6:
        return False
    if isinstance(value, str):
        lowered = value.lower()
        return any(token in lowered for token in tokens)
    if isinstance(value, Mapping):
        for key, item in value.items():
            if _mentions_at(key, tokens, depth=depth + 1):
                return True
            if _mentions_at(item, tokens, depth=depth + 1):
                return True
        return False
    if isinstance(value, (list, tuple)):
        return any(_mentions_at(item, tokens, depth=depth + 1) for item in value)
    return False


def _is_resolvable_party(entry: Any) -> bool:
    """Whether an ownership entry actually names somebody a consumer could reach.

    An ownership block that lists a role with no name, no address and no channel is
    *present* but not *resolvable* — the ticket asks for both, and they are different
    defects with different fixes.

    Args:
        entry: One entry of an ownership block.

    Returns:
        ``True`` when the entry carries a name, a username, an email, or a channel/URL.
    """
    if _has_text(entry):
        return True
    if not isinstance(entry, Mapping):
        return False
    for key in ("name", "username", "email", "channel", "url", "contact", "owner", "team"):
        if _has_text(entry.get(key)):
            return True
    return False


# ---------------------------------------------------------------------------
# The facts
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ContractFacts:
    """The governance facts one canonical artifact states, read once.

    Built by :func:`read_contract_facts` and handed to every rule in the FMT-5.5 pack, so
    the pack contains no knowledge of any format's extras namespace and one document is
    walked once rather than once per rule.

    Attributes:
        api: The artifact these facts were read from.
        owners: Every ownership entry the artifact declares, from any namespace.
        resolvable_owners: The subset that names a reachable party.
        sla_entries: Every declared service-level entry.
        server_entries: Every declared serving location, at root or on a type.
        root_quality: Contract-level quality rules.
        status: The declared lifecycle status, when the source states one.
    """

    api: CanonicalApi
    owners: Tuple[Any, ...]
    resolvable_owners: Tuple[Any, ...]
    sla_entries: Tuple[Any, ...]
    server_entries: Tuple[Any, ...]
    root_quality: Tuple[Any, ...]
    status: Optional[str]

    # -- root-level questions ---------------------------------------------

    def has_owner(self) -> bool:
        """Whether the artifact declares ownership at all."""
        return bool(self.owners)

    def has_resolvable_owner(self) -> bool:
        """Whether at least one ownership entry names a reachable party."""
        return bool(self.resolvable_owners)

    def has_sla(self) -> bool:
        """Whether the artifact declares any service-level property."""
        return bool(self.sla_entries)

    def has_server(self) -> bool:
        """Whether the artifact says where the dataset is served from.

        Canonical ``servers`` count as well as the carried extras: a data format that *does*
        project onto the canonical server list has answered the question natively.
        """
        return bool(self.server_entries) or bool(self.api.servers)

    def has_freshness(self) -> bool:
        """Whether any declared SLA, quality rule or resource config promises freshness."""
        if _mentions(self.sla_entries, FRESHNESS_TOKENS):
            return True
        if _mentions(self.root_quality, FRESHNESS_TOKENS):
            return True
        for type_ in self.api.types:
            extras = _extras(type_)
            if _mentions(extras.get("dbt_freshness"), FRESHNESS_TOKENS):
                return True
            if _mentions(extras.get(QUALITY_EXTRA_KEY), FRESHNESS_TOKENS):
                return True
        return False

    def has_retention(self) -> bool:
        """Whether any declared SLA or resource config states a retention window."""
        if _mentions(self.sla_entries, RETENTION_TOKENS):
            return True
        for type_ in self.api.types:
            extras = _extras(type_)
            if _mentions(extras.get("dbt_config"), RETENTION_TOKENS):
                return True
            if _mentions(extras.get("odcs_custom_properties"), RETENTION_TOKENS):
                return True
        return _mentions(_extras(self.api).get("odcs_custom_properties"), RETENTION_TOKENS)

    def has_version(self) -> bool:
        """Whether the artifact declares its own version."""
        return _has_text(self.api.version)

    def has_status(self) -> bool:
        """Whether the artifact declares a lifecycle status."""
        return _has_text(self.status)

    # -- per-type / per-field questions ------------------------------------

    def quality_rules_for(self, node: Any) -> Tuple[Any, ...]:
        """Return the quality rules declared directly on ``node``.

        Args:
            node: A :class:`~app.canonical_model.Type` or
                :class:`~app.canonical_model.CanonicalField`.

        Returns:
            The rules from the shared quality namespace; empty when the node declares none.
        """
        return tuple(_entries(_extras(node).get(QUALITY_EXTRA_KEY)))

    def has_declared_expectation(self, type_: Type, field: CanonicalField) -> bool:
        """Whether ``field`` carries a declared expectation about its data.

        A quality rule is the obvious form, and a rule attached to the *type* (or to the
        contract) covers every one of its columns — that is what a table-level expectation
        means. But it is not the only form: the readers deliberately model what the
        canonical vocabulary *can* hold, so a dbt ``not_null`` test becomes nullability and
        an ``accepted_values`` test becomes an ``enum`` rather than a carried rule. Counting
        only the carried rules would report a column as unchecked precisely because its
        check was modelled well, so every landing place counts here.

        Args:
            type_: The owning type.
            field: The field to check.

        Returns:
            ``True`` when some declared expectation covers the field.
        """
        if self.quality_rules_for(field):
            return True
        if bool(self.quality_rules_for(type_)) or bool(self.root_quality):
            return True
        if field.constraints is not None:
            return True
        if not field.type.nullable:
            return True
        return self.declares_identity(field)

    def identity_fields(self, type_: Type) -> Tuple[CanonicalField, ...]:
        """Return the fields of ``type_`` that declare row identity.

        Args:
            type_: The type to inspect.

        Returns:
            Its primary-key / unique fields, in declaration order.
        """
        return tuple(field for field in type_.fields if self.declares_identity(field))

    def has_identity(self, type_: Type) -> bool:
        """Whether ``type_`` declares row identity on a field or as a model constraint."""
        if self.identity_fields(type_):
            return True
        extras = _extras(type_)
        for key in _CONSTRAINT_EXTRA_KEYS:
            for entry in _entries(extras.get(key)):
                if isinstance(entry, Mapping):
                    declared = str(entry.get("type") or "").strip().lower()
                    if declared in _IDENTITY_CONSTRAINT_TYPES:
                        return True
        return False

    @staticmethod
    def declares_identity(field: CanonicalField) -> bool:
        """Whether ``field`` is declared a primary key or unique.

        Args:
            field: The field to inspect.

        Returns:
            ``True`` when any identity namespace marks it, or a field-level model constraint
            declares ``primary_key``/``unique``.
        """
        extras = _extras(field)
        for key in IDENTITY_EXTRA_KEYS:
            declared = extras.get(key)
            if isinstance(declared, Mapping) and any(bool(v) for v in declared.values()):
                return True
            if declared is True:
                return True
        for key in _CONSTRAINT_EXTRA_KEYS:
            for entry in _entries(extras.get(key)):
                if isinstance(entry, Mapping):
                    if str(entry.get("type") or "").strip().lower() in _IDENTITY_CONSTRAINT_TYPES:
                        return True
        return False

    @staticmethod
    def is_classified(field: CanonicalField) -> bool:
        """Whether ``field`` carries a governance classification.

        Any confidentiality label or critical-data marker counts; a ``meta``/``tags`` block
        counts only when it actually reads as a personal-data marker, because those two are
        free-form and a ``nightly`` tag is not a classification.

        Args:
            field: The field to inspect.

        Returns:
            ``True`` when the field is classified.
        """
        extras = _extras(field)
        for key in CLASSIFICATION_EXTRA_KEYS:
            value = extras.get(key)
            if _has_text(value) or value is True:
                return True
        return any(_mentions(extras.get(key), _PII_TOKENS) for key in CLASSIFICATION_LABEL_KEYS)

    @staticmethod
    def is_critical(field: CanonicalField) -> bool:
        """Whether ``field`` is declared a *critical data element*.

        This is what "per critical column" means in the ticket: a column the **contract
        itself** singled out with a governance marker — a critical-data-element flag or a
        confidentiality classification — not every column in the table. Row identity is
        deliberately *not* criticality: a primary key already carries its own declared
        expectation (see :meth:`has_declared_expectation`), so counting it here would make
        that half of the rule unable to fire.

        Args:
            field: The field to inspect.

        Returns:
            ``True`` when the field is critical.
        """
        extras = _extras(field)
        if extras.get("odcs_critical_data_element"):
            return True
        return _has_text(extras.get("odcs_classification"))

    @staticmethod
    def described_fields(type_: Type) -> Tuple[int, int]:
        """Return ``(described, total)`` field counts for ``type_``.

        Args:
            type_: The type to measure.

        Returns:
            How many of its fields carry a non-blank description, and how many there are.
        """
        total = len(type_.fields)
        described = sum(1 for field in type_.fields if _has_text(field.description))
        return described, total


def _collect(extras: Mapping[str, Any], keys: Sequence[str]) -> List[Any]:
    """Collect every entry ``extras`` holds under any of ``keys``, in key order."""
    found: List[Any] = []
    for key in keys:
        found.extend(_entries(extras.get(key)))
    return found


def _declared_status(api: CanonicalApi) -> Optional[str]:
    """Read the lifecycle status a data-schema reader recorded, if any.

    Each reader records its own projection record under its format key (``extras['odcs']``,
    ``extras['dbt']``, …); a ``status`` inside one of those is the contract's declared
    lifecycle state. A bare root-level ``status`` is read too, as the generic spelling.

    Args:
        api: The artifact.

    Returns:
        The declared status, or ``None``.
    """
    extras = _extras(api)
    direct = extras.get("status")
    if _has_text(direct):
        return str(direct).strip()
    for value in extras.values():
        if isinstance(value, Mapping) and _has_text(value.get("status")):
            return str(value["status"]).strip()
    return None


def read_contract_facts(api: CanonicalApi) -> ContractFacts:
    """Read every governance fact one artifact states, once.

    Args:
        api: The canonical artifact. Not mutated.

    Returns:
        The :class:`ContractFacts` the FMT-5.5 rule pack asks its questions of.
    """
    root = _extras(api)
    owners: List[Any] = _collect(root, OWNER_EXTRA_KEYS)
    # An owner-*bearing* entry contributes its `owner` block and nothing else, so an entry
    # that declares no owner contributes nothing rather than passing on its own name.
    for entry in _collect(root, OWNER_BEARING_EXTRA_KEYS):
        if isinstance(entry, Mapping) and entry.get("owner") is not None:
            owners.append(entry["owner"])

    servers = _collect(root, SERVER_EXTRA_KEYS)
    for type_ in api.types:
        servers.extend(_collect(_extras(type_), ("dbt_relation",)))

    return ContractFacts(
        api=api,
        owners=tuple(owners),
        resolvable_owners=tuple(e for e in owners if _is_resolvable_party(e)),
        sla_entries=tuple(_collect(root, SLA_EXTRA_KEYS)),
        server_entries=tuple(servers),
        root_quality=tuple(_entries(root.get(QUALITY_EXTRA_KEY))),
        status=_declared_status(api),
    )
