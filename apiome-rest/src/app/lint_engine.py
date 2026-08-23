"""Generalized lint engine + rule-pack SPI over the canonical model — MFI-4.1 (#3746).

The original linter (:mod:`app.schema_lint`) targets one format: it walks a reconstructed
OpenAPI/JSON-Schema document and emits deterministic :class:`~app.schema_lint.LintFinding`
items with a 0-100 score, an A-F grade, and a stable ``report_fingerprint``. That is exactly
the right shape, but it is hard-wired to OpenAPI. Every other importable format
(gRPC/protobuf, AsyncAPI, GraphQL, Avro, …) is normalized into the single
:class:`~app.canonical_model.CanonicalApi` shape (MFI-2.1), so the *quality* checks should
be written once over that canonical model and reused for every paradigm.

This module generalizes the linter into a pluggable **rule-pack engine**, mirroring the
fingerprint-hasher (:mod:`app.fingerprint`) and breaking-change-classifier
(:mod:`app.breaking_change`) registries that sit beside it:

* **A rule pack** (:class:`RulePack`) is an ordered list of :class:`LintRule` items. Each
  rule carries a stable ``rule_id`` (``common.type-missing-description``), a ``category``
  (its group: ``documentation`` / ``naming`` / ``structure`` / …), a ``severity``, and a
  pure ``check`` that yields ``(path, message)`` pairs over a :class:`CanonicalApi`. The
  pack turns each pair into a :class:`~app.schema_lint.LintFinding` whose ``id`` is the same
  stable ``path|rule|message`` hash the OpenAPI linter uses.

* **The "common" pack** (:class:`CommonRulePack`) covers cross-format hygiene that holds for
  *every* paradigm — missing descriptions (artifact, type, field, operation, message,
  channel) and unstable identifiers (auto-generated/positional names that will not survive a
  re-import and so wreck diff alignment). It always runs.

* **The "examples" pack** (:class:`app.example_conformance_lint.ExampleConformanceRulePack`,
  IXH-5.4) is the second **unconditional** pack. It checks that every ``example``/``examples``
  in the artifact's *retained source document* satisfies the schema it sits next to — a
  cross-format defect wearing different syntax in OpenAPI, AsyncAPI, and JSON Schema — and
  self-gates to nothing when the artifact retained no walkable document. Both unconditional
  packs are published by :func:`unconditional_rule_packs`, which is what the rule catalogue
  enumerates, so "what always runs" has exactly one definition.

* **Format packs** register under a format key via the same ``register=True`` SPI the sibling
  registries use, and add the specifics their ecosystem cares about (a GraphQL pack, an
  AsyncAPI pack, …). :func:`lint_canonical_model` runs the unconditional packs plus the format
  pack registered for ``api.format``, if any.

* **Paradigm packs** (FMT-5.5) register under a *paradigm* key with ``register_paradigm=True``
  and run for every artifact of that family, whatever syntax it arrived in. The data-contract
  pack (:mod:`app.data_contract_lint`) is the first: "is there a reachable owner, a stated
  service level, a documented retention window" are the same questions for an ODCS contract
  and a dbt project, and neither is a question to ask a REST description. A paradigm pack may
  also publish **category bars** (:meth:`RulePack.categories_for`) so a clean artifact still
  shows it ran, and may **self-gate** to nothing for an artifact it has no standing to judge.

The OpenAPI behavior is unchanged: :func:`app.schema_lint.lint_openapi_spec` remains the
OpenAPI rule pack and reproduces its current findings exactly (its tests are untouched). Both
linters share :func:`app.schema_lint.assemble_lint_result`, so the score / grade / fingerprint
formula is identical no matter which pack produced the findings.

Design goals (the same three the OpenAPI linter holds):

* **Deterministic** — the same :class:`CanonicalApi` always yields the same findings, score,
  grade, and fingerprint. Entities are visited in sorted-key order and the assembled result
  re-sorts by ``(path, rule, id)``, so emission order never leaks into the output.
* **Pure** — no database, no network, no clock. Callers pass a fully built model.
* **Composable** — pre-built findings (e.g. compatibility flags from
  :mod:`app.breaking_change`) merge into the report and the score via ``extra_findings``,
  exactly as :func:`app.schema_lint.lint_openapi_spec` accepts them.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Callable, ClassVar, Dict, Iterable, List, Optional, Tuple

from .canonical_model import (
    CanonicalApi,
    CanonicalField,
    Channel,
    Message,
    Operation,
    Service,
    Type,
)
from .schema_lint import LintFinding, LintResult, Severity, assemble_lint_result

__all__ = [
    "LintRule",
    "RulePack",
    "CommonRulePack",
    "lint_canonical_model",
    "register_rule_pack",
    "register_paradigm_rule_pack",
    "get_rule_pack",
    "get_paradigm_rule_pack",
    "available_lint_formats",
    "available_lint_paradigms",
    "is_unstable_name",
    "load_format_rule_packs",
    "unconditional_rule_packs",
]


# ===========================================================================
# Rule and rule-pack abstractions
# ===========================================================================


#: A rule's check: given the artifact, yield ``(path, message)`` pairs — one per defect the
#: rule finds. The rule (not the check) supplies the category/severity/id, so a check stays a
#: small pure generator over the model. An empty iterable means the rule is satisfied.
RuleCheck = Callable[[CanonicalApi], Iterable[Tuple[str, str]]]


@dataclass(frozen=True)
class LintRule:
    """One lint rule: a stable id + group + severity bound to a pure ``check``.

    A :class:`RulePack` runs its rules in order; each ``(path, message)`` the ``check`` yields
    becomes a :class:`~app.schema_lint.LintFinding` tagged with this rule's ``rule_id``,
    ``category`` (its group), and ``severity``. The finding ``id`` is then the same stable
    ``path|rule|message`` hash the OpenAPI linter uses, so a defect has one durable id no
    matter which pack reported it.

    Attributes:
        rule_id: Stable, namespaced identifier (e.g. ``common.type-missing-description``).
            Forms the finding's ``rule`` field and part of its id hash, so it must not change
            once shipped.
        category: The rule's group — ``documentation`` / ``naming`` / ``structure`` /
            ``compatibility`` — used for grouping and per-rule penalty capping.
        severity: ``"error"`` | ``"warning"`` | ``"info"``; drives the score penalty.
        description: One-line human description of what the rule checks (for docs / catalogs).
        check: Pure generator yielding ``(path, message)`` for each defect found.
    """

    rule_id: str
    category: str
    severity: Severity
    description: str
    check: RuleCheck

    def run(self, api: CanonicalApi) -> List[LintFinding]:
        """Run this rule over ``api`` and return its findings in the check's yield order.

        Args:
            api: The canonical artifact to lint. Not mutated.

        Returns:
            One :class:`~app.schema_lint.LintFinding` per ``(path, message)`` the check yields.
        """
        return [
            LintFinding(
                path=path,
                category=self.category,
                rule=self.rule_id,
                severity=self.severity,
                message=message,
            )
            for path, message in self.check(api)
        ]


class RulePack(ABC):
    """Service-provider contract for a set of lint rules over the canonical model.

    A pack is an ordered list of :class:`LintRule` items (returned by :meth:`rules`) that the
    engine runs over a :class:`~app.canonical_model.CanonicalApi`. The format-agnostic
    :class:`CommonRulePack` always runs; a format whose ecosystem has its own hygiene rules
    registers a pack under its :attr:`format` key and :func:`lint_canonical_model` runs it in
    addition to the common pack.

    A pack must be **deterministic and pure**: the same model yields the same findings, with
    no I/O. Subclasses register via the ``register=True`` flag
    (``class GraphqlRulePack(RulePack, register=True): ...``) or
    :func:`register_rule_pack`, and are looked up by ``format`` with :func:`get_rule_pack`.
    """

    #: Source format key this pack applies to, matched against
    #: :attr:`app.canonical_model.CanonicalApi.format`. Empty means "common" — the pack
    #: applies to every format and is never resolved through the registry (it always runs).
    format: ClassVar[str] = ""

    #: Paradigm this pack applies to, matched against
    #: :attr:`app.canonical_model.CanonicalApi.paradigm` (FMT-5.5, #5443). A *paradigm* pack
    #: asks questions that hold for a whole family of formats rather than for one syntax —
    #: a data contract's ownership, service level and quality expectations are the same
    #: questions whether the source was ODCS, dbt or a Connect schema. Empty means the pack
    #: is not paradigm-scoped.
    paradigm: ClassVar[str] = ""

    #: Categories this pack always contributes to the report's per-category rollup, even
    #: with no findings, so a clean artifact still publishes the bar. Empty for a pack whose
    #: categories are whatever its findings happened to carry.
    base_categories: ClassVar[Tuple[str, ...]] = ()

    #: Stable identifier recorded on findings/diagnostics; defaults to the class name.
    pack_id: ClassVar[str] = ""

    def __init_subclass__(
        cls, *, register: bool = False, register_paradigm: bool = False, **kwargs: Any
    ) -> None:
        """Optionally self-register a concrete subclass in one of the rule-pack registries.

        Args:
            register: When ``True``, the subclass is added to the *format* registry under
                its :attr:`format` key as soon as it is defined.
            register_paradigm: When ``True``, the subclass is added to the *paradigm*
                registry under its :attr:`paradigm` key as soon as it is defined.
        """
        super().__init_subclass__(**kwargs)
        if register:
            register_rule_pack(cls)
        if register_paradigm:
            register_paradigm_rule_pack(cls)

    @abstractmethod
    def rules(self) -> List[LintRule]:
        """Return this pack's rules in deterministic execution order."""
        raise NotImplementedError

    def categories_for(self, api: CanonicalApi) -> Tuple[str, ...]:
        """Return the category bars this pack publishes for ``api``, even with no findings.

        The default is :attr:`base_categories`. A pack that **self-gates** — one that
        contributes nothing for an artifact it has no standing to judge — overrides this to
        return ``()`` for that artifact, so a report cannot claim a clean bar for a pack that
        never ran.

        Args:
            api: The canonical artifact about to be linted.

        Returns:
            The category names to publish.
        """
        return tuple(self.base_categories)

    def lint(self, api: CanonicalApi) -> List[LintFinding]:
        """Run every rule in this pack over ``api`` and collect their findings.

        The default runs :meth:`rules` in order and concatenates each rule's findings. The
        engine re-sorts the combined result deterministically, so a pack need not sort here.

        Args:
            api: The canonical artifact to lint. Not mutated.

        Returns:
            All findings this pack produced, in rule-then-yield order.
        """
        findings: List[LintFinding] = []
        for rule in self.rules():
            findings.extend(rule.run(api))
        return findings


# Format-key -> rule-pack-class registry. A format epic registers its pack here so
# `lint_canonical_model` can lint per-format without this module importing every format
# package. The common pack is NOT stored here — it is unconditional.
_RULE_PACK_REGISTRY: Dict[str, type[RulePack]] = {}


def register_rule_pack(cls: type[RulePack]) -> type[RulePack]:
    """Register a concrete :class:`RulePack` under its ``format`` key.

    Args:
        cls: A concrete :class:`RulePack` subclass with a non-empty ``format``.

    Returns:
        ``cls`` unchanged, so this can also be used as a class decorator.

    Raises:
        ValueError: If ``cls.format`` is empty (the common pack must not be registered — it
            always runs), or a *different* class is already registered under the same format
            key (re-registering the same class is a no-op, so module re-import is safe).
    """
    key = cls.format
    if not key:
        raise ValueError(
            f"{cls.__name__} must set a non-empty `format` to register "
            "(the common pack runs unconditionally and is not registered)"
        )
    existing = _RULE_PACK_REGISTRY.get(key)
    if existing is not None and existing is not cls:
        raise ValueError(
            f"rule pack for format {key!r} already registered to {existing.__name__}; "
            f"cannot re-register to {cls.__name__}"
        )
    _RULE_PACK_REGISTRY[key] = cls
    return cls


# Paradigm-key -> rule-pack-class registry (FMT-5.5, #5443). Separate from the format
# registry because the two are different questions and a pack answers exactly one of them:
# a *format* pack knows a syntax's own hygiene, a *paradigm* pack knows what an artifact of
# that family has to state regardless of which syntax stated it.
_PARADIGM_RULE_PACK_REGISTRY: Dict[str, type[RulePack]] = {}


def _paradigm_key(paradigm: Any) -> str:
    """Normalize a paradigm to its registry key.

    :class:`~app.canonical_model.ApiParadigm` is a ``str`` enum, and ``str(member)`` renders
    as ``ApiParadigm.DATA_SCHEMA`` rather than ``data_schema`` on Python 3.11+. Both the
    registration side (which is handed an enum member as a class attribute) and the lookup
    side (which is handed ``api.paradigm``) go through here, so the two cannot disagree
    about the key — which is exactly how a pack silently stops running.

    Args:
        paradigm: An :class:`~app.canonical_model.ApiParadigm`, its string value, or ``""``.

    Returns:
        The paradigm's string value, or ``""`` when there is none.
    """
    value = getattr(paradigm, "value", paradigm)
    return str(value) if value else ""


def register_paradigm_rule_pack(cls: type[RulePack]) -> type[RulePack]:
    """Register a concrete :class:`RulePack` under its ``paradigm`` key.

    Args:
        cls: A concrete :class:`RulePack` subclass with a non-empty ``paradigm``.

    Returns:
        ``cls`` unchanged, so this can also be used as a class decorator.

    Raises:
        ValueError: If ``cls.paradigm`` is empty, or a *different* class is already
            registered under the same paradigm key (re-registering the same class is a
            no-op, so module re-import is safe).
    """
    key = _paradigm_key(cls.paradigm)
    if not key:
        raise ValueError(
            f"{cls.__name__} must set a non-empty `paradigm` to register as a paradigm pack"
        )
    existing = _PARADIGM_RULE_PACK_REGISTRY.get(key)
    if existing is not None and existing is not cls:
        raise ValueError(
            f"paradigm rule pack for {key!r} already registered to {existing.__name__}; "
            f"cannot re-register to {cls.__name__}"
        )
    _PARADIGM_RULE_PACK_REGISTRY[key] = cls
    return cls


def get_paradigm_rule_pack(paradigm: Any) -> Optional[type[RulePack]]:
    """Return the rule-pack class registered for ``paradigm``, or ``None``.

    Args:
        paradigm: An :class:`~app.canonical_model.ApiParadigm` or its string value.

    Returns:
        The registered pack class, or ``None`` when the paradigm has none.
    """
    load_format_rule_packs()
    return _PARADIGM_RULE_PACK_REGISTRY.get(_paradigm_key(paradigm))


def available_lint_paradigms() -> List[str]:
    """Return the sorted paradigm keys that have a registered rule pack."""
    load_format_rule_packs()
    return sorted(_PARADIGM_RULE_PACK_REGISTRY)


def get_rule_pack(format_key: str) -> Optional[type[RulePack]]:
    """Return the rule-pack class registered for ``format_key``, or ``None``."""
    load_format_rule_packs()
    return _RULE_PACK_REGISTRY.get(format_key)


def available_lint_formats() -> List[str]:
    """Return the sorted format keys that have a registered rule pack."""
    load_format_rule_packs()
    return sorted(_RULE_PACK_REGISTRY)


# Have the built-in format packs been imported (and so self-registered) yet?
_format_packs_loaded = False


def load_format_rule_packs() -> None:
    """Import the built-in format rule-pack modules so they self-register.

    A format pack lives in its own module and registers via the ``register=True`` subclass
    flag, so it is only in the registry once its module has been imported. This loader pulls
    those modules in lazily — the import happens **inside** the function to avoid a cycle (a
    pack module imports :class:`RulePack`/:func:`lint_canonical_model` from here), and is
    idempotent and cheap after the first call. It runs ahead of every registry read
    (:func:`get_rule_pack`, :func:`available_lint_formats`) and every lint
    (:func:`lint_canonical_model`), so a pack resolves no matter which entry point is hit
    first — mirroring :func:`app.import_source.load_builtin_import_sources`.
    """
    global _format_packs_loaded
    if _format_packs_loaded:
        return
    _format_packs_loaded = True
    # AsyncAPI lint pack (MFI-8.3): registers under ``asyncapi-2`` / ``asyncapi-3``.
    # Arazzo lint pack (MFI-30.2): registers under ``arazzo``.
    from . import arazzo_lint as _arazzo_lint  # noqa: F401
    from . import asyncapi_lint as _asyncapi_lint  # noqa: F401

    # GraphQL lint pack (MFI-10.4): registers under ``graphql``.
    from . import graphql_lint as _graphql_lint  # noqa: F401

    # Protobuf lint pack (MFI-9.4): registers under ``protobuf``.
    from . import proto_lint as _proto_lint  # noqa: F401

    # Kubernetes CRD lint pack (IXH-7.2): registers under ``k8s-crd``.
    from . import k8s_crd_lint as _k8s_crd_lint  # noqa: F401
    # LLM tool-bundle lint pack (IXH-7.3): registers under ``llm-tools``.
    from . import llm_tools_lint as _llm_tools_lint  # noqa: F401

    # Data-contract lint pack (FMT-5.5): registers under the ``data_schema`` *paradigm*,
    # so it runs for every data-schema artifact rather than for one format key.
    from . import data_contract_lint as _data_contract_lint  # noqa: F401


# ===========================================================================
# Cross-format hygiene helpers (shared by the common pack's rules)
# ===========================================================================


def _nonempty_str(value: Any) -> bool:
    """True when ``value`` is a non-blank string."""
    return isinstance(value, str) and value.strip() != ""


# An identifier is "unstable" when it looks machine-generated or positional rather than
# author-chosen, because such names rarely survive a re-import and so wreck the diff
# alignment that versioning (MFI-3.x) depends on. The heuristic is deliberately conservative:
# it only flags the well-known generator outputs — `InlineObject`, `InlineResponse200`,
# `AnonymousType3`, `body`, `schema1`, `_12`, `type_0`, an empty name — so a normal author
# name (`Pet`, `userId`, `GetPet`) is never flagged. It is documented as a heuristic, and a
# format pack can sharpen it for its own generator conventions.
_UNSTABLE_NAME = re.compile(
    r"""
    ^(?:
        \s*                                        # blank / whitespace-only
        |_*\d+                                     # purely positional: _12, 007
        |(?:inline|anonymous|unnamed|generated)    # known generator stems...
            (?:response|object|type|schema|enum|input|payload)?
            [_-]?\d*
        |(?:body|schema|object|type|enum|payload|input|response|class)
            [_-]?\d+                                # generic-noun + number: schema1, type_0
    )$
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _is_unstable_name(name: Any) -> bool:
    """Return whether ``name`` matches the documented generated/positional pattern."""
    return isinstance(name, str) and bool(_UNSTABLE_NAME.match(name))


def is_unstable_name(name: Any) -> bool:
    """Public alias of the shared "looks auto-generated/positional" heuristic.

    Exposed so a format pack (e.g. the AsyncAPI pack in :mod:`app.asyncapi_lint`) can apply
    the exact same import-stability heuristic the common pack uses for type/field names to
    its own entities (message names), without duplicating the regex or reaching into a
    private helper.

    Args:
        name: The candidate identifier (any value; non-strings are never unstable).

    Returns:
        ``True`` when ``name`` matches the documented generated/positional pattern.
    """
    return _is_unstable_name(name)


# ===========================================================================
# The common (cross-format) rule pack
# ===========================================================================


def _services_sorted(api: CanonicalApi) -> List[Service]:
    return sorted(api.services, key=lambda s: s.key)


def _operations_sorted(service: Service) -> List[Operation]:
    return sorted(service.operations, key=lambda o: o.key)


def _messages_sorted(operation: Operation) -> List[Message]:
    return sorted(operation.messages, key=lambda m: m.key)


def _types_sorted(api: CanonicalApi) -> List[Type]:
    return sorted(api.types, key=lambda t: t.key)


def _fields_sorted(api_type: Type) -> List[CanonicalField]:
    return sorted(api_type.fields, key=lambda f: f.key)


def _channels_sorted(api: CanonicalApi) -> List[Channel]:
    return sorted(api.channels, key=lambda c: c.key)


def _check_api_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """The artifact itself should describe what the API is for."""
    if not _nonempty_str(api.description):
        yield ("api", f"API '{api.identity.name}' is missing a description.")


def _check_type_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Every named type should describe itself."""
    for api_type in _types_sorted(api):
        if not _nonempty_str(api_type.description):
            yield (
                f"types.{api_type.key}",
                f"Type '{api_type.name}' is missing a description.",
            )


def _check_field_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Every field of every type should describe itself."""
    for api_type in _types_sorted(api):
        for field in _fields_sorted(api_type):
            if not _nonempty_str(field.description):
                yield (
                    f"types.{api_type.key}.fields.{field.key}",
                    f"Field '{field.name}' is missing a description.",
                )


def _check_operation_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Every operation should describe what it does."""
    for service in _services_sorted(api):
        for operation in _operations_sorted(service):
            if not _nonempty_str(operation.description):
                yield (
                    f"services.{service.key}.operations.{operation.key}",
                    f"Operation '{operation.name}' is missing a description.",
                )


def _check_message_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Every message (request/response/event payload) should describe itself."""
    for service in _services_sorted(api):
        for operation in _operations_sorted(service):
            for message in _messages_sorted(operation):
                if not _nonempty_str(message.description):
                    yield (
                        f"services.{service.key}.operations.{operation.key}"
                        f".messages.{message.key}",
                        f"Message '{message.key}' is missing a description.",
                    )


def _check_channel_missing_description(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Every event channel should describe itself."""
    for channel in _channels_sorted(api):
        if not _nonempty_str(channel.description):
            yield (
                f"channels.{channel.key}",
                f"Channel '{channel.address}' is missing a description.",
            )


def _check_unstable_type_name(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Type names should be author-chosen, not generator output."""
    for api_type in _types_sorted(api):
        if _is_unstable_name(api_type.name):
            yield (
                f"types.{api_type.key}",
                f"Type name '{api_type.name}' looks auto-generated/positional and is "
                "unstable across re-imports.",
            )


def _check_unstable_field_name(api: CanonicalApi) -> Iterable[Tuple[str, str]]:
    """Field names should be author-chosen, not generator output."""
    for api_type in _types_sorted(api):
        for field in _fields_sorted(api_type):
            if _is_unstable_name(field.name):
                yield (
                    f"types.{api_type.key}.fields.{field.key}",
                    f"Field name '{field.name}' looks auto-generated/positional and is "
                    "unstable across re-imports.",
                )


class CommonRulePack(RulePack):
    """The format-agnostic hygiene pack that always runs, for every paradigm.

    It encodes the two cross-format concerns the roadmap calls out — **missing descriptions**
    and **unstable identifiers** — over the canonical entities every format normalizes into:
    the artifact, its types and their fields, its services' operations and those operations'
    messages, and its event channels. A format pack adds the specifics its ecosystem cares
    about on top of this baseline; nothing here is OpenAPI-specific.

    Its :attr:`format` is empty, so it is never registered (it runs unconditionally) and is
    rejected by :func:`register_rule_pack` if someone tries.
    """

    pack_id: ClassVar[str] = "common"

    #: Built once at class-definition time: the pack is stateless and the rule list is
    #: constant, so all instances share it. Order here is the rules' deterministic execution
    #: order (the engine re-sorts findings anyway, so this is for readability/grouping).
    _RULES: ClassVar[Tuple[LintRule, ...]] = (
        LintRule(
            rule_id="common.api-missing-description",
            category="documentation",
            severity="info",
            description="The API artifact should carry a top-level description.",
            check=_check_api_missing_description,
        ),
        LintRule(
            rule_id="common.type-missing-description",
            category="documentation",
            severity="warning",
            description="Every named type should describe itself.",
            check=_check_type_missing_description,
        ),
        LintRule(
            rule_id="common.field-missing-description",
            category="documentation",
            severity="info",
            description="Every field should describe itself.",
            check=_check_field_missing_description,
        ),
        LintRule(
            rule_id="common.operation-missing-description",
            category="documentation",
            severity="warning",
            description="Every operation should describe what it does.",
            check=_check_operation_missing_description,
        ),
        LintRule(
            rule_id="common.message-missing-description",
            category="documentation",
            severity="info",
            description="Every message payload should describe itself.",
            check=_check_message_missing_description,
        ),
        LintRule(
            rule_id="common.channel-missing-description",
            category="documentation",
            severity="info",
            description="Every event channel should describe itself.",
            check=_check_channel_missing_description,
        ),
        LintRule(
            rule_id="common.unstable-type-name",
            category="naming",
            severity="warning",
            description="Type names should be author-chosen, not generator output.",
            check=_check_unstable_type_name,
        ),
        LintRule(
            rule_id="common.unstable-field-name",
            category="naming",
            severity="warning",
            description="Field names should be author-chosen, not generator output.",
            check=_check_unstable_field_name,
        ),
    )

    def rules(self) -> List[LintRule]:
        """Return the common pack's rules in deterministic execution order."""
        return list(self._RULES)


# A single shared instance is safe: the common pack is stateless and pure.
_COMMON = CommonRulePack()

# The example-conformance pack (IXH-5.4) is the second unconditional pack. It lives in its own
# module because it walks the artifact's *retained source document* rather than the canonical
# model, and it is instantiated lazily through this accessor to keep the import one-directional
# (the pack imports LintRule/RulePack from here).
_EXAMPLES_PACK: Optional[RulePack] = None


def _example_conformance_pack() -> RulePack:
    """Return the shared, unconditional example-conformance pack (stateless and pure)."""
    global _EXAMPLES_PACK
    if _EXAMPLES_PACK is None:
        from .example_conformance_lint import ExampleConformanceRulePack

        _EXAMPLES_PACK = ExampleConformanceRulePack()
    return _EXAMPLES_PACK


def unconditional_rule_packs() -> List[RulePack]:
    """Return every pack that runs for **all** formats, in execution order.

    The two packs that carry no ``format`` key and are therefore never in the registry: the
    cross-format hygiene pack and the example-conformance pack. Exposed so the rule catalogue
    (:mod:`app.lint_rule_registry`) enumerates exactly what the engine runs, instead of keeping
    its own list that could fall behind.
    """
    return [_COMMON, _example_conformance_pack()]


# ===========================================================================
# Top-level entry point
# ===========================================================================


def lint_canonical_model(
    api: CanonicalApi,
    extra_findings: Optional[List[LintFinding]] = None,
) -> LintResult:
    """Lint a canonical artifact with the common pack plus its format pack, deterministically.

    Runs :class:`CommonRulePack` (always) and, when one is registered for ``api.format``, that
    format's :class:`RulePack`, merges any caller-supplied ``extra_findings`` (e.g.
    compatibility flags from :mod:`app.breaking_change`), and rolls everything up through the
    shared :func:`app.schema_lint.assemble_lint_result` — so the score, grade, and
    ``report_fingerprint`` use the exact same formula as the OpenAPI linter.

    Args:
        api: The canonical artifact to lint. Not mutated.
        extra_findings: Optional pre-built findings to merge into the report and the score.

    Returns:
        A deterministic :class:`~app.schema_lint.LintResult` (score, grade, sorted findings,
        rule hits, severity counts, fingerprint).
    """
    load_format_rule_packs()
    findings: List[LintFinding] = list(extra_findings or [])
    findings.extend(_COMMON.lint(api))
    findings.extend(_example_conformance_pack().lint(api))

    base_categories: Tuple[str, ...] = ()
    paradigm_cls = get_paradigm_rule_pack(api.paradigm)
    if paradigm_cls is not None:
        paradigm_pack = paradigm_cls()
        findings.extend(paradigm_pack.lint(api))
        # A paradigm pack's category bars are published even on a clean artifact, so a
        # consumer can tell "scored by this pack and clean" from "never scored by it" — and
        # a pack that self-gated for this artifact publishes none, so the distinction holds.
        base_categories = paradigm_pack.categories_for(api)

    pack_cls = get_rule_pack(api.format)
    if pack_cls is not None:
        findings.extend(pack_cls().lint(api))

    return assemble_lint_result(findings, base_categories=base_categories)
