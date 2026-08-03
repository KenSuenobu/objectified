"""WIT → canonical model normalizer — IXH-7.9.

Maps a parsed :class:`~app.wit_parser.WitDocument` onto the RPC paradigm of the
:class:`~app.canonical_model.CanonicalApi`:

* **interfaces and worlds become services** — an interface's freestanding
  functions and a world's directly imported/exported functions become
  :class:`~app.canonical_model.Operation` entries;
* **WIT types become canonical types** — ``record`` → RECORD, ``enum`` → ENUM,
  ``variant`` → UNION (case payloads preserved in extras), ``flags`` → ENUM
  (bitset semantics flagged in extras), ``type`` aliases → ALIAS, ``resource`` →
  RECORD carrying its constructor/methods in extras;
* ``option<t>`` maps to canonical nullability (WIT types are otherwise
  non-nullable), ``list<t>`` to list nesting, ``result<ok, err>`` on a function
  return to a RESPONSE plus an ERROR message.

Constructs the canonical model cannot express are **capability limits, never
silent drops** (IXH-7.9): resources with methods, ``borrow<…>`` handle
semantics, tuples, nested ``result``/``stream``/``future`` uses, and
``use`` targets outside the supplied package are each preserved in ``extras``
and recorded in the ``extras["wit"]`` report that
:mod:`app.import_preview_manifest` renders as coverage-ledger rows.

``use`` statements resolve against the interfaces of the supplied package (a
single file or a merged multi-file fileset); a use naming another package is
recorded as an external reference rather than resolved.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .canonical_model import (
    ApiIdentity,
    ApiParadigm,
    CanonicalApi,
    CanonicalField,
    EnumValue,
    Message,
    MessageRole,
    Operation,
    OperationKind,
    Service,
    StreamingMode,
    Type,
    TypeKind,
    TypeRef,
)
from .normalizer import Keys, Normalizer, normalize_ordering
from .wit_parser import (
    WitDocument,
    WitFunction,
    WitInterface,
    WitUse,
    WitWorld,
)

__all__ = ["WitNormalizer"]

_FORMAT_KEY = "wit"

#: WIT primitive → canonical scalar name (the shared vocabulary the other RPC
#: normalizers use; see e.g. :data:`app.capnproto_normalizer._CAPNP_BASE_TO_CANONICAL`).
_WIT_PRIMITIVE_TO_CANONICAL: Dict[str, str] = {
    "bool": "bool",
    "u8": "uint8",
    "u16": "uint16",
    "u32": "uint32",
    "u64": "uint64",
    "s8": "int8",
    "s16": "i16",
    "s32": "i32",
    "s64": "i64",
    "f32": "float",
    "f64": "double",
    "float32": "float",
    "float64": "double",
    "string": "string",
}


@dataclass
class _LimitCollector:
    """Accumulates the document's capability-limit report while normalizing.

    One collector per :meth:`WitNormalizer.normalize` call; its content becomes
    ``extras["wit"]["capability_limits"]`` — the record the preview manifest
    renders as ledger rows, so nothing the canonical model cannot hold is
    silently dropped.
    """

    limits: List[Dict[str, Any]] = field(default_factory=list)
    external_uses: List[str] = field(default_factory=list)

    def add(self, *, construct: str, kind: str, detail: str, count: int = 1) -> None:
        """Record one capability limit (merged by construct+kind, counts summed)."""
        for entry in self.limits:
            if entry["construct"] == construct and entry["kind"] == kind:
                entry["count"] += count
                return
        self.limits.append(
            {"construct": construct, "kind": kind, "count": count, "detail": detail}
        )

    def add_external_use(self, path: str, names: Tuple[str, ...]) -> None:
        """Record a ``use`` whose target lives outside the supplied package."""
        rendered = f"{path}.{{{', '.join(names)}}}"
        if rendered not in self.external_uses:
            self.external_uses.append(rendered)


@dataclass(frozen=True)
class _Symbols:
    """Type-name resolution context for one interface (or world) scope.

    ``local`` maps a name usable in this scope to the canonical type key it
    resolves to — the scope's own types plus everything its ``use`` statements
    imported from sibling interfaces of the package.
    """

    local: Dict[str, str]
    scope: str  # for limit-report construct labels


class WitNormalizer(Normalizer, register=True):
    """Normalize a parsed WIT document into a :class:`CanonicalApi`."""

    format = _FORMAT_KEY
    paradigm = ApiParadigm.RPC

    def normalize(self, source: Any, *, include_raw: bool = True) -> CanonicalApi:
        if not isinstance(source, WitDocument):
            raise ValueError(
                "WIT source must be a WitDocument (see app.wit_parser.parse_wit)"
            )

        namespace = source.package
        limits = _LimitCollector()

        # Interface name → {type name → canonical key} for cross-interface `use`.
        package_types: Dict[str, Dict[str, str]] = {}
        all_interfaces: List[WitInterface] = list(source.interfaces)
        for world in source.worlds:
            all_interfaces.extend(
                ref.inline for ref in world.interface_refs if ref.inline is not None
            )
        for iface in all_interfaces:
            package_types[iface.name] = {
                name: Keys.type(f"{iface.name}.{name}", namespace)
                for name in iface.type_names()
            }

        types: List[Type] = []
        services: List[Service] = []

        for iface in all_interfaces:
            symbols = self._interface_symbols(iface, package_types, limits)
            types.extend(self._interface_types(iface, symbols, namespace, limits))
            service = self._interface_service(iface, symbols, namespace, limits)
            if service is not None:
                services.append(service)

        for world in source.worlds:
            services.append(
                self._world_service(world, package_types, namespace, limits)
            )

        if source.extra_package_blocks:
            limits.add(
                construct="package#nested-blocks",
                kind="nested-package-blocks",
                count=source.extra_package_blocks,
                detail=(
                    "The document nests additional package blocks beyond the first; "
                    "their contents are not read (declared parser limit)."
                ),
            )

        report: Dict[str, Any] = {
            "package": source.package,
            "version": source.version,
            "capability_limits": limits.limits,
            "external_uses": limits.external_uses,
            "worlds": [world.name for world in source.worlds],
            "unexpanded_includes": sorted(
                {inc for world in source.worlds for inc in world.includes}
            ),
        }

        identity_name = (
            source.package
            or (source.worlds[0].name if source.worlds else None)
            or (source.interfaces[0].name if source.interfaces else "WIT package")
        )
        paradigm = ApiParadigm.RPC if services else ApiParadigm.DATA_SCHEMA
        extras: Dict[str, Any] = {"wit": report}
        if source.source_files:
            extras["source_files"] = list(source.source_files)

        api = CanonicalApi(
            paradigm=paradigm,
            format=self.format,
            identity=ApiIdentity(name=identity_name, namespace=namespace),
            version=source.version,
            services=services,
            types=types,
            raw={"wit": source.raw} if include_raw else None,
            extras=extras,
        )
        return normalize_ordering(api)

    # --- symbol resolution --------------------------------------------------

    def _interface_symbols(
        self,
        iface: WitInterface,
        package_types: Dict[str, Dict[str, str]],
        limits: _LimitCollector,
    ) -> _Symbols:
        """Build the name → canonical-key map visible inside ``iface``.

        Own types shadow imports (matching WIT, where a redeclaration is an
        error the tooling rejects before this point). A ``use`` naming a sibling
        interface of the package resolves; anything else is recorded as an
        external reference.
        """
        local: Dict[str, str] = {}
        for use in iface.uses:
            self._apply_use(use, package_types, local, limits)
        local.update(package_types.get(iface.name, {}))
        return _Symbols(local=local, scope=iface.name)

    def _apply_use(
        self,
        use: WitUse,
        package_types: Dict[str, Dict[str, str]],
        local: Dict[str, str],
        limits: _LimitCollector,
    ) -> None:
        """Resolve one ``use`` statement into ``local``, or record it as external."""
        target = package_types.get(use.path)
        if target is None:
            limits.add_external_use(use.path, tuple(name for name, _ in use.names))
            for name, alias in use.names:
                # The referenced type stays a named reference; the unresolved
                # source is preserved so the reference is explainable.
                local[alias or name] = name
            return
        for name, alias in use.names:
            key = target.get(name)
            if key is None:
                limits.add_external_use(use.path, (name,))
                local[alias or name] = name
            else:
                local[alias or name] = key

    # --- type expressions ---------------------------------------------------

    def _type_ref(self, expr: str, symbols: _Symbols, limits: _LimitCollector) -> TypeRef:
        """Map a WIT type expression onto a :class:`TypeRef`.

        WIT types are non-nullable by default, so every level is emitted with
        ``nullable=False`` except an ``option<…>`` wrapper, which maps exactly
        onto canonical nullability. Constructs with no canonical shape (tuples,
        nested results, borrow/own handles, stream/future) resolve to their most
        useful canonical approximation with the WIT spelling preserved in
        ``extras`` and a capability limit recorded.
        """
        t = " ".join(expr.split())

        generic = re.fullmatch(r"([a-z][a-z0-9-]*)\s*<(.+)>", t, re.DOTALL)
        if generic:
            head, args_blob = generic.group(1), generic.group(2)
            args = _split_generic_args(args_blob)
            if head == "list" and len(args) == 1:
                return TypeRef(
                    item=self._type_ref(args[0], symbols, limits), nullable=False
                )
            if head == "option" and len(args) == 1:
                inner = self._type_ref(args[0], symbols, limits)
                return inner.model_copy(update={"nullable": True})
            if head in ("borrow", "own") and len(args) == 1:
                inner = self._type_ref(args[0], symbols, limits)
                if head == "borrow":
                    limits.add(
                        construct=f"borrow#{symbols.scope}",
                        kind="borrow-handle",
                        detail=(
                            "borrow<…> handle semantics (temporary, non-owning "
                            "resource access) have no canonical representation; the "
                            "referenced type is used with the handle kind preserved "
                            "in extras."
                        ),
                    )
                extras = dict(inner.extras)
                extras["wit_handle"] = head
                return inner.model_copy(update={"extras": extras})
            if head == "result":
                limits.add(
                    construct=f"result#{symbols.scope}",
                    kind="nested-result",
                    detail=(
                        "result<…> used as a plain type (not a function return) has "
                        "no canonical representation; the ok arm is referenced with "
                        "the WIT spelling preserved in extras."
                    ),
                )
                ok = args[0] if args and args[0] != "_" else None
                base = (
                    self._type_ref(ok, symbols, limits)
                    if ok
                    else TypeRef(name="void", nullable=False)
                )
                extras = dict(base.extras)
                extras["wit_type"] = t
                return base.model_copy(update={"extras": extras})
            if head == "tuple":
                limits.add(
                    construct=f"tuple#{symbols.scope}",
                    kind="tuple",
                    detail=(
                        "tuple<…> has no canonical representation; it is referenced "
                        "as an opaque type with the WIT spelling preserved in extras."
                    ),
                )
                return TypeRef(name="tuple", nullable=False, extras={"wit_type": t})
            if head in ("stream", "future"):
                limits.add(
                    construct=f"{head}#{symbols.scope}",
                    kind="stream-future",
                    detail=(
                        f"{head}<…> (WIT async) has no canonical type representation; "
                        "the element type is referenced with the async wrapper "
                        "preserved in extras."
                    ),
                )
                inner = (
                    self._type_ref(args[0], symbols, limits)
                    if args
                    else TypeRef(name="void", nullable=False)
                )
                extras = dict(inner.extras)
                extras["wit_async"] = head
                return inner.model_copy(update={"extras": extras})
            # Unknown generic head: keep the expression opaque but visible.
            limits.add(
                construct=f"type#{symbols.scope}",
                kind="unsupported-type-expression",
                detail=f"Type expression {t!r} is not interpreted; preserved verbatim.",
            )
            return TypeRef(name=head, nullable=False, extras={"wit_type": t})

        mapped = _WIT_PRIMITIVE_TO_CANONICAL.get(t)
        if mapped:
            return TypeRef(name=mapped, nullable=False)
        if t == "char":
            # A single Unicode scalar value; canonical has no char scalar.
            return TypeRef(name="string", nullable=False, extras={"wit_type": "char"})

        resolved = symbols.local.get(t)
        if resolved:
            return TypeRef(name=resolved, nullable=False)
        # Unresolved bare name (e.g. imported via an unresolvable `use`).
        return TypeRef(name=t, nullable=False)

    # --- types ----------------------------------------------------------------

    def _interface_types(
        self,
        iface: WitInterface,
        symbols: _Symbols,
        namespace: Optional[str],
        limits: _LimitCollector,
    ) -> List[Type]:
        """Normalize one interface's type definitions."""
        types: List[Type] = []
        qual = lambda name: Keys.type(f"{iface.name}.{name}", namespace)  # noqa: E731

        for record in iface.records:
            type_key = qual(record.name)
            types.append(
                Type(
                    key=type_key,
                    name=record.name,
                    kind=TypeKind.RECORD,
                    namespace=namespace,
                    fields=[
                        CanonicalField(
                            key=Keys.field(type_key, f.name),
                            name=f.name,
                            type=self._type_ref(f.type_expr, symbols, limits),
                        )
                        for f in record.fields
                    ],
                    extras={"wit_kind": "record", "wit_interface": iface.name},
                )
            )

        for enum in iface.enums:
            type_key = qual(enum.name)
            types.append(
                Type(
                    key=type_key,
                    name=enum.name,
                    kind=TypeKind.ENUM,
                    namespace=namespace,
                    enum_values=[
                        EnumValue(key=Keys.enum_value(type_key, case), name=case)
                        for case in enum.cases
                    ],
                    extras={"wit_kind": "enum", "wit_interface": iface.name},
                )
            )

        for flags in iface.flags:
            type_key = qual(flags.name)
            types.append(
                Type(
                    key=type_key,
                    name=flags.name,
                    kind=TypeKind.ENUM,
                    namespace=namespace,
                    enum_values=[
                        EnumValue(key=Keys.enum_value(type_key, flag), name=flag)
                        for flag in flags.flags
                    ],
                    # A flags value is a *set* of these members (a bitset), not one
                    # of them — the distinction canonical ENUM cannot carry.
                    extras={"wit_kind": "flags", "wit_interface": iface.name},
                )
            )

        for variant in iface.variants:
            type_key = qual(variant.name)
            members: List[str] = []
            cases_detail: List[Dict[str, Any]] = []
            for case in variant.cases:
                payload_ref: Optional[TypeRef] = None
                if case.payload is not None:
                    payload_ref = self._type_ref(case.payload, symbols, limits)
                    if payload_ref.name and not payload_ref.is_list():
                        members.append(payload_ref.name)
                cases_detail.append(
                    {
                        "name": case.name,
                        "payload": case.payload,
                    }
                )
            types.append(
                Type(
                    key=type_key,
                    name=variant.name,
                    kind=TypeKind.UNION,
                    namespace=namespace,
                    union_members=members,
                    extras={
                        "wit_kind": "variant",
                        "wit_interface": iface.name,
                        "wit_cases": cases_detail,
                    },
                )
            )

        for alias in iface.aliases:
            type_key = qual(alias.name)
            types.append(
                Type(
                    key=type_key,
                    name=alias.name,
                    kind=TypeKind.ALIAS,
                    namespace=namespace,
                    aliased=self._type_ref(alias.target, symbols, limits),
                    extras={"wit_kind": "type-alias", "wit_interface": iface.name},
                )
            )

        for resource in iface.resources:
            type_key = qual(resource.name)
            # Resolve method/constructor signatures so inexpressible constructs
            # inside them (borrow handles, tuples, nested results) are recorded
            # as capability limits even though the signatures themselves live in
            # extras rather than as canonical operations.
            for func in (resource.constructor, *resource.methods):
                if func is None:
                    continue
                for param in func.params:
                    self._type_ref(param.type_expr, symbols, limits)
                if func.result is not None:
                    ok_expr, err_expr = _split_function_result(func.result)
                    for expr in (ok_expr, err_expr):
                        if expr is not None:
                            self._type_ref(expr, symbols, limits)
            extras: Dict[str, Any] = {
                "wit_kind": "resource",
                "wit_interface": iface.name,
            }
            if resource.constructor is not None:
                extras["wit_constructor"] = _function_dict(resource.constructor)
            if resource.methods:
                extras["wit_methods"] = [_function_dict(m) for m in resource.methods]
            method_count = len(resource.methods) + (1 if resource.constructor else 0)
            if method_count:
                limits.add(
                    construct=f"resource#{iface.name}.{resource.name}",
                    kind="resource-methods",
                    count=method_count,
                    detail=(
                        f"Resource {resource.name!r} declares {method_count} "
                        "constructor/method(s); the canonical model cannot express "
                        "resource-scoped methods as operations, so they are preserved "
                        "in the type's extras."
                    ),
                )
            types.append(
                Type(
                    key=type_key,
                    name=resource.name,
                    kind=TypeKind.RECORD,
                    namespace=namespace,
                    extras=extras,
                )
            )

        return types

    # --- services / operations ------------------------------------------------

    def _operation(
        self,
        service_key: str,
        func: WitFunction,
        symbols: _Symbols,
        limits: _LimitCollector,
        *,
        extra_extras: Optional[Dict[str, Any]] = None,
    ) -> Operation:
        """Normalize one function into an :class:`Operation` with its messages."""
        op_key = Keys.operation_rpc(service_key, func.name)
        messages: List[Message] = []

        if func.params:
            if len(func.params) == 1:
                param = func.params[0]
                messages.append(
                    Message(
                        key=Keys.request_message(op_key),
                        role=MessageRole.REQUEST,
                        payload=self._type_ref(param.type_expr, symbols, limits),
                        required=True,
                        extras={"wit_param_name": param.name},
                    )
                )
            else:
                # Multiple parameters have no single canonical payload; each is
                # preserved with its WIT spelling *and* its resolved canonical
                # reference, so named types keep their stable keys (and any
                # inexpressible construct in a parameter is still recorded as a
                # capability limit by the resolution).
                messages.append(
                    Message(
                        key=Keys.request_message(op_key),
                        role=MessageRole.REQUEST,
                        required=True,
                        extras={
                            "wit_params": [
                                {
                                    "name": p.name,
                                    "type": p.type_expr,
                                    "resolved": self._type_ref(
                                        p.type_expr, symbols, limits
                                    ).model_dump(mode="json"),
                                }
                                for p in func.params
                            ]
                        },
                    )
                )

        if func.result is not None:
            ok_expr, err_expr = _split_function_result(func.result)
            if ok_expr is not None:
                messages.append(
                    Message(
                        key=f"{op_key}#response",
                        role=MessageRole.RESPONSE,
                        payload=self._type_ref(ok_expr, symbols, limits),
                    )
                )
            if err_expr is not None:
                messages.append(
                    Message(
                        key=f"{op_key}#error",
                        role=MessageRole.ERROR,
                        payload=self._type_ref(err_expr, symbols, limits),
                    )
                )
        elif func.named_results:
            messages.append(
                Message(
                    key=f"{op_key}#response",
                    role=MessageRole.RESPONSE,
                    extras={
                        "wit_results": [
                            {"name": r.name, "type": r.type_expr}
                            for r in func.named_results
                        ]
                    },
                )
            )

        extras: Dict[str, Any] = {}
        if func.is_async:
            extras["wit_async"] = True
        if extra_extras:
            extras.update(extra_extras)
        return Operation(
            key=op_key,
            name=func.name,
            kind=OperationKind.REQUEST_RESPONSE,
            streaming=StreamingMode.NONE,
            messages=messages,
            extras=extras,
        )

    def _interface_service(
        self,
        iface: WitInterface,
        symbols: _Symbols,
        namespace: Optional[str],
        limits: _LimitCollector,
    ) -> Optional[Service]:
        """Normalize one interface into a service, or ``None`` when it is types-only."""
        if not iface.functions:
            return None
        service_key = Keys.type(iface.name, namespace)
        operations = [
            self._operation(service_key, func, symbols, limits)
            for func in iface.functions
        ]
        return Service(
            key=service_key,
            name=iface.name,
            operations=operations,
            extras={"wit_kind": "interface"},
        )

    def _world_service(
        self,
        world: WitWorld,
        package_types: Dict[str, Dict[str, str]],
        namespace: Optional[str],
        limits: _LimitCollector,
    ) -> Service:
        """Normalize one world into a service.

        The world's directly imported/exported functions become its operations
        (direction preserved per operation); interface imports/exports and
        unexpanded ``include`` statements ride in the service extras, since the
        referenced interfaces are modeled as their own services.
        """
        service_key = Keys.type(world.name, namespace)
        local: Dict[str, str] = {}
        for use in world.uses:
            self._apply_use(use, package_types, local, limits)
        symbols = _Symbols(local=local, scope=world.name)

        operations = [
            self._operation(
                service_key,
                entry.function,
                symbols,
                limits,
                extra_extras={"wit_direction": entry.direction},
            )
            for entry in world.functions
        ]
        return Service(
            key=service_key,
            name=world.name,
            operations=operations,
            extras={
                "wit_kind": "world",
                "wit_imports": [
                    ref.path for ref in world.interface_refs if ref.direction == "import"
                ],
                "wit_exports": [
                    ref.path for ref in world.interface_refs if ref.direction == "export"
                ],
                "wit_includes": list(world.includes),
            },
        )


def _split_generic_args(blob: str) -> List[str]:
    """Split ``a, list<b>, c`` on commas not nested inside ``<>`` or ``()``."""
    parts: List[str] = []
    current: List[str] = []
    depth = 0
    for ch in blob:
        if ch in "<(":
            depth += 1
        elif ch in ">)":
            depth = max(0, depth - 1)
        if ch == "," and depth == 0:
            parts.append("".join(current).strip())
            current = []
            continue
        current.append(ch)
    tail = "".join(current).strip()
    if tail:
        parts.append(tail)
    return parts


def _split_function_result(result_expr: str) -> Tuple[Optional[str], Optional[str]]:
    """Split a function's return expression into (ok payload, error payload).

    A top-of-return ``result<ok, err>`` maps onto the canonical RESPONSE/ERROR
    message pair — the one place WIT's ``result`` *is* canonical-expressible.
    Bare ``result`` (no arms) and ``result<_, err>`` yield no ok payload.
    Any other expression is entirely the ok payload.
    """
    t = " ".join(result_expr.split())
    if t == "result":
        return None, None
    match = re.fullmatch(r"result\s*<(.+)>", t, re.DOTALL)
    if not match:
        return t, None
    args = _split_generic_args(match.group(1))
    ok = args[0] if args and args[0] != "_" else None
    err = args[1] if len(args) > 1 and args[1] != "_" else None
    return ok, err


def _function_dict(func: WitFunction) -> Dict[str, Any]:
    """Serialize a resource constructor/method for the owning type's extras."""
    out: Dict[str, Any] = {
        "name": func.name,
        "kind": func.kind,
        "params": [{"name": p.name, "type": p.type_expr} for p in func.params],
    }
    if func.result is not None:
        out["result"] = func.result
    if func.named_results:
        out["results"] = [
            {"name": r.name, "type": r.type_expr} for r in func.named_results
        ]
    if func.is_async:
        out["async"] = True
    return out
