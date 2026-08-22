"""Tests for the Protobuf lint pack (MFI-9.4, #3767).

The acceptance criteria are: **lints a sample**, and **findings are scored**. These tests pin
four layers, mirroring ``test_graphql_lint.py``:

* the **native rule pack** (:class:`app.proto_lint.ProtobufRulePack`) — each of the three rules
  the roadmap calls out (versioned package, no ``required``, ``reserved`` on deletion) fires on a
  defective model and a clean model produces no ``protobuf.*`` finding — driven through the
  *real* MFI-9.2 :class:`~app.proto_normalizer.ProtoNormalizer` over synthetic descriptor sets
  (no ``buf``), so the canonical coordinates the rules emit are genuine;
* the **buf lint mapping** (:func:`app.proto_lint.buf_findings` /
  :func:`app.proto_lint.parse_buf_lint_output`) — ``buf lint`` JSON output becomes namespaced,
  warning-severity findings;
* the **runner** (:func:`app.proto_lint.run_buf_lint`) — driven with an injected fake toolchain
  runner (no ``buf``): exit-100 violations are returned, build failures raise
  :class:`~app.proto_lint.ProtoLintError`, and the scratch module carries the lint ``buf.yaml``;
* the **merge** — :func:`app.proto_lint.lint_protobuf_result` rolls buf + native + common into
  one deterministic score, plus a gated end-to-end test over the committed fixtures with the
  real bundled ``buf``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set

import pytest
from google.protobuf import descriptor_pb2

from app.lint_engine import available_lint_formats, get_rule_pack, lint_canonical_model
from app.proto_descriptor import (
    BUF_TOOL_KEY,
    ProtoFile,
    ProtoCompileError,
)
from app.proto_lint import (
    BUF_LINT_MODULE_YAML,
    BUF_LINT_RULE_PREFIX,
    ProtobufRulePack,
    ProtoLintError,
    buf_findings,
    lint_protobuf,
    lint_protobuf_result,
    parse_buf_lint_output,
    run_buf_lint,
)
from app.proto_normalizer import ProtoNormalizer
from app.schema_lint import LintResult
from app.toolchain_packaging import probe_tool
from app.toolchain_runner import (
    ToolExecutionError,
    ToolNotAvailableError,
    ToolSpec,
    ToolTimeoutError,
)

_FD = descriptor_pb2.FieldDescriptorProto
_FIXTURES = Path(__file__).parent / "fixtures" / "proto"


# ===========================================================================
# Synthetic descriptor builders (real models via MFI-9.2, no buf)
# ===========================================================================


def _model(fds: descriptor_pb2.FileDescriptorSet):
    """Normalize a hand-built descriptor set into the canonical model (every file a target)."""
    return ProtoNormalizer().normalize(fds)


def _file(fds: descriptor_pb2.FileDescriptorSet, name: str, package: str):
    f = fds.file.add()
    f.name = name
    f.package = package
    f.syntax = "proto3"
    return f


def _scalar(message, name: str, number: int, *, label: int = _FD.LABEL_OPTIONAL):
    field_proto = message.field.add()
    field_proto.name = name
    field_proto.number = number
    field_proto.type = _FD.TYPE_STRING
    field_proto.label = label
    return field_proto


def _clean_descriptor_set() -> descriptor_pb2.FileDescriptorSet:
    """A tidy proto3 set: versioned package, no ``required``, contiguous numbers, no gaps."""
    fds = descriptor_pb2.FileDescriptorSet()
    f = _file(fds, "user/user.proto", "acme.user.v1")
    user = f.message_type.add()
    user.name = "User"
    _scalar(user, "id", 1)
    _scalar(user, "name", 2)
    role = f.enum_type.add()
    role.name = "Role"
    role.value.add(name="ROLE_UNSPECIFIED", number=0)
    role.value.add(name="ROLE_ADMIN", number=1)
    return fds


def _native_rules(result: LintResult) -> Set[str]:
    """The set of native ``protobuf.*`` rule ids fired (excludes the buf-lint namespace)."""
    return {
        f.rule
        for f in result.findings
        if f.rule.startswith("protobuf.")
        and not f.rule.startswith(BUF_LINT_RULE_PREFIX)
    }


# ===========================================================================
# Native rules — a clean model is silent; each defect fires its rule
# ===========================================================================


def test_clean_model_has_no_native_protobuf_findings() -> None:
    result = lint_canonical_model(_model(_clean_descriptor_set()))
    assert not _native_rules(result)


def test_unversioned_package_fires_version_suffix_rule() -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = _file(fds, "user/user.proto", "acme.user")  # no version component
    msg = f.message_type.add()
    msg.name = "User"
    _scalar(msg, "id", 1)
    _scalar(msg, "name", 2)
    result = lint_canonical_model(_model(fds))
    fired = [f for f in result.findings if f.rule == "protobuf.package-version-suffix"]
    assert [f.path for f in fired] == ["package"]


@pytest.mark.parametrize("package", ["acme.user.v1", "acme.v1beta1", "foo.v2", "p.v1p1alpha1"])
def test_versioned_packages_pass(package: str) -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = _file(fds, "a.proto", package)
    msg = f.message_type.add()
    msg.name = "M"
    _scalar(msg, "id", 1)
    fired = _native_rules(lint_canonical_model(_model(fds)))
    assert "protobuf.package-version-suffix" not in fired


def test_missing_package_fires_version_suffix_rule() -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "a.proto"  # no package at all
    f.syntax = "proto3"
    msg = f.message_type.add()
    msg.name = "M"
    _scalar(msg, "id", 1)
    fired = _native_rules(lint_canonical_model(_model(fds)))
    assert "protobuf.package-version-suffix" in fired


def test_required_field_fires_no_required_rule() -> None:
    # proto2 so a ``required`` label is legal in the descriptor.
    fds = descriptor_pb2.FileDescriptorSet()
    f = fds.file.add()
    f.name = "legacy.proto"
    f.package = "legacy.v1"
    f.syntax = "proto2"
    msg = f.message_type.add()
    msg.name = "Legacy"
    _scalar(msg, "id", 1, label=_FD.LABEL_REQUIRED)
    _scalar(msg, "name", 2, label=_FD.LABEL_OPTIONAL)
    result = lint_canonical_model(_model(fds))
    fired = [f for f in result.findings if f.rule == "protobuf.field-no-required"]
    assert [f.path for f in fired] == ["types.legacy.v1.Legacy.fields.legacy.v1.Legacy.id"]


def test_field_number_gap_fires_reserved_rule_unless_reserved() -> None:
    # Fields 1 and 4 used → 2,3 are an un-reserved gap.
    fds = descriptor_pb2.FileDescriptorSet()
    f = _file(fds, "a.proto", "acme.v1")
    msg = f.message_type.add()
    msg.name = "M"
    _scalar(msg, "a", 1)
    _scalar(msg, "d", 4)
    result = lint_canonical_model(_model(fds))
    gap = [f for f in result.findings if f.rule == "protobuf.reserved-on-deletion"]
    assert len(gap) == 1
    assert gap[0].path == "types.acme.v1.M"
    assert "2 to 3" in gap[0].message

    # Reserve 2..3 (descriptor end is exclusive → [2, 4)) and the gap is silenced.
    msg.reserved_range.add(start=2, end=4)
    silenced = lint_canonical_model(_model(fds))
    assert not [f for f in silenced.findings if f.rule == "protobuf.reserved-on-deletion"]


def test_enum_value_gap_fires_reserved_rule_unless_reserved() -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = _file(fds, "a.proto", "acme.v1")
    enum = f.enum_type.add()
    enum.name = "E"
    enum.value.add(name="E_UNSPECIFIED", number=0)
    enum.value.add(name="E_C", number=3)  # 1,2 missing
    result = lint_canonical_model(_model(fds))
    gap = [f for f in result.findings if f.rule == "protobuf.reserved-on-deletion"]
    assert len(gap) == 1
    assert gap[0].path == "types.acme.v1.E"
    assert "1 to 2" in gap[0].message

    # Enum reserved ranges are inclusive → [1, 2] covers both.
    enum.reserved_range.add(start=1, end=2)
    silenced = lint_canonical_model(_model(fds))
    assert not [f for f in silenced.findings if f.rule == "protobuf.reserved-on-deletion"]


def test_sparse_layout_below_min_is_not_flagged() -> None:
    # Numbers 10 and 11 (contiguous, high start) → no gap between min and max.
    fds = descriptor_pb2.FileDescriptorSet()
    f = _file(fds, "a.proto", "acme.v1")
    msg = f.message_type.add()
    msg.name = "M"
    _scalar(msg, "a", 10)
    _scalar(msg, "b", 11)
    fired = _native_rules(lint_canonical_model(_model(fds)))
    assert "protobuf.reserved-on-deletion" not in fired


def test_findings_are_deterministic() -> None:
    fds = _clean_descriptor_set()
    a = lint_canonical_model(_model(fds))
    b = lint_canonical_model(_model(fds))
    assert a.report_fingerprint == b.report_fingerprint
    assert a.score == b.score


# ===========================================================================
# Editions feature rules — FMT-3.7 (#5432)
# ===========================================================================
#
# These rules read the resolved feature values only an Editions model carries, so a
# proto2/proto3 artifact is silent under all of them — asserted directly below, because the
# alternative (new findings on every shipped protobuf golden) is the failure mode that matters.


def _editions_file(fds: descriptor_pb2.FileDescriptorSet, name: str, package: str):
    """Add an Editions 2023 file to ``fds`` and return it."""
    f = fds.file.add()
    f.name = name
    f.package = package
    f.syntax = "editions"
    f.edition = descriptor_pb2.Edition.EDITION_2023
    return f


def _editions_descriptor_set() -> descriptor_pb2.FileDescriptorSet:
    """A clean-but-for-features Editions set: versioned package, no gaps, no ``required``."""
    fds = descriptor_pb2.FileDescriptorSet()
    f = _editions_file(fds, "order/order.proto", "acme.order.v1")
    order = f.message_type.add()
    order.name = "Order"
    _scalar(order, "id", 1)
    _scalar(order, "sku", 2)
    status = f.enum_type.add()
    status.name = "Status"
    status.value.add(name="STATUS_UNSPECIFIED", number=0)
    status.value.add(name="STATUS_OPEN", number=1)
    return fds


def test_editions_model_with_default_features_fires_no_editions_rule() -> None:
    """An Editions document that took every default is as clean as a tidy proto3 one."""
    result = lint_canonical_model(_model(_editions_descriptor_set()))
    assert not {rule for rule in _native_rules(result) if ".editions." in rule}


def test_editions_legacy_required_fires_the_no_required_rule() -> None:
    """The rule read ``extras['label']`` only, so it passed every Editions document."""
    fds = _editions_descriptor_set()
    order = fds.file[0].message_type[0]
    order.field[0].options.features.field_presence = (
        descriptor_pb2.FeatureSet.LEGACY_REQUIRED
    )
    result = lint_canonical_model(_model(fds))
    assert "protobuf.field-no-required" in _native_rules(result)
    # The descriptor label is still `optional`; only the resolved feature says otherwise.
    assert order.field[0].label == _FD.LABEL_OPTIONAL


def test_editions_delimited_encoding_is_flagged() -> None:
    fds = _editions_descriptor_set()
    order = fds.file[0].message_type[0]
    nested = order.field.add()
    nested.name = "grouped"
    nested.number = 3
    nested.type = _FD.TYPE_MESSAGE
    nested.type_name = ".acme.order.v1.Order"
    nested.label = _FD.LABEL_OPTIONAL
    nested.options.features.message_encoding = descriptor_pb2.FeatureSet.DELIMITED

    result = lint_canonical_model(_model(fds))
    assert "protobuf.editions.delimited-encoding" in _native_rules(result)
    finding = next(
        f for f in result.findings if f.rule == "protobuf.editions.delimited-encoding"
    )
    assert "grouped" in finding.message
    assert finding.severity == "warning"


def test_editions_utf8_validation_off_is_flagged() -> None:
    fds = _editions_descriptor_set()
    order = fds.file[0].message_type[0]
    order.field[1].options.features.utf8_validation = descriptor_pb2.FeatureSet.NONE

    result = lint_canonical_model(_model(fds))
    assert "protobuf.editions.utf8-validation-off" in _native_rules(result)


def test_editions_legacy_json_format_is_flagged_at_file_and_message_scope() -> None:
    """A file-wide opt-out is reported once at the artifact; a message's on the message."""
    file_scope = _editions_descriptor_set()
    file_scope.file[0].options.features.json_format = (
        descriptor_pb2.FeatureSet.LEGACY_BEST_EFFORT
    )
    result = lint_canonical_model(_model(file_scope))
    findings = [
        f for f in result.findings if f.rule == "protobuf.editions.legacy-json-format"
    ]
    assert [f.path for f in findings] == ["package"]

    message_scope = _editions_descriptor_set()
    message_scope.file[0].message_type[0].options.features.json_format = (
        descriptor_pb2.FeatureSet.LEGACY_BEST_EFFORT
    )
    result = lint_canonical_model(_model(message_scope))
    findings = [
        f for f in result.findings if f.rule == "protobuf.editions.legacy-json-format"
    ]
    assert [f.path for f in findings] == ["types.acme.order.v1.Order"]


def test_editions_closed_enum_is_flagged() -> None:
    fds = _editions_descriptor_set()
    fds.file[0].enum_type[0].options.features.enum_type = descriptor_pb2.FeatureSet.CLOSED
    result = lint_canonical_model(_model(fds))
    assert "protobuf.editions.closed-enum" in _native_rules(result)


def test_editions_rules_are_silent_on_proto3_and_proto2_models() -> None:
    """The gate that keeps every shipped protobuf golden's lint roll-up unchanged."""
    proto3 = lint_canonical_model(_model(_clean_descriptor_set()))
    assert not {rule for rule in _native_rules(proto3) if ".editions." in rule}

    fds = descriptor_pb2.FileDescriptorSet()
    f = _file(fds, "legacy/legacy.proto", "acme.legacy.v1")
    f.ClearField("syntax")  # proto2: closed enums, required fields, no JSON guarantee
    legacy = f.message_type.add()
    legacy.name = "Legacy"
    _scalar(legacy, "id", 1, label=_FD.LABEL_REQUIRED)
    enum = f.enum_type.add()
    enum.name = "Kind"
    enum.value.add(name="KIND_UNSPECIFIED", number=0)

    proto2 = lint_canonical_model(_model(fds))
    # proto2 resolves CLOSED enums and LEGACY_BEST_EFFORT JSON, but says so through its
    # syntax rather than through features — the editions rules must not start firing on it.
    assert not {rule for rule in _native_rules(proto2) if ".editions." in rule}
    # ...while the label-based required rule still fires, exactly as it did before FMT-3.7.
    assert "protobuf.field-no-required" in _native_rules(proto2)


def test_editions_findings_are_scored_like_any_other() -> None:
    """MFI-9.4's acceptance carried forward: a new finding moves the score."""
    clean = lint_protobuf_result(_model(_editions_descriptor_set()))
    fds = _editions_descriptor_set()
    fds.file[0].enum_type[0].options.features.enum_type = descriptor_pb2.FeatureSet.CLOSED
    flagged = lint_protobuf_result(_model(fds))
    assert flagged.score < clean.score


# ===========================================================================
# Registry
# ===========================================================================


def test_pack_registered_under_protobuf_format() -> None:
    assert get_rule_pack("protobuf") is ProtobufRulePack
    assert "protobuf" in available_lint_formats()


def test_pack_rule_ids_are_unique_and_namespaced() -> None:
    rule_ids = [r.rule_id for r in ProtobufRulePack().rules()]
    assert rule_ids
    assert len(rule_ids) == len(set(rule_ids))
    assert all(r.startswith("protobuf.") for r in rule_ids)


# ===========================================================================
# buf lint output → canonical findings
# ===========================================================================


def test_buf_findings_namespace_and_path() -> None:
    report = [
        {
            "path": "user/user.proto",
            "start_line": 3,
            "start_column": 1,
            "type": "PACKAGE_VERSION_SUFFIX",
            "message": "bad package",
        },
        {"path": "user/user.proto", "start_line": 7, "type": "COMMENT_MESSAGE", "message": "no comment"},
    ]
    findings = buf_findings(report)
    assert [f.rule for f in findings] == [
        f"{BUF_LINT_RULE_PREFIX}.package_version_suffix",
        f"{BUF_LINT_RULE_PREFIX}.comment_message",
    ]
    assert [f.severity for f in findings] == ["warning", "warning"]
    assert [f.category for f in findings] == ["buf-lint", "buf-lint"]
    assert findings[0].path == "user/user.proto:3:1"
    assert findings[1].path == "user/user.proto:7"  # column omitted → line only


def test_buf_findings_missing_fields_degrade() -> None:
    findings = buf_findings([{"message": "orphan"}])  # no type, no path/line
    assert findings[0].rule == f"{BUF_LINT_RULE_PREFIX}.unknown"
    assert findings[0].path == "(proto)"


def test_buf_findings_accepts_single_str_and_empty() -> None:
    single = {"path": "a.proto", "type": "ENUM_PASCAL_CASE", "message": "m"}
    assert len(buf_findings(single)) == 1
    jsonl = (
        '{"path":"a.proto","start_line":1,"type":"PACKAGE_LOWER_SNAKE_CASE","message":"m"}\n'
        "\n"  # blank line skipped
        "not json at all\n"  # non-JSON line skipped
        '{"path":"a.proto","start_line":2,"type":"SERVICE_SUFFIX","message":"m"}'
    )
    assert len(buf_findings(jsonl)) == 2
    assert buf_findings(None) == []
    assert buf_findings("") == []
    assert buf_findings([]) == []


def test_parse_buf_lint_output_skips_noise() -> None:
    out = '  {"type":"X","message":"a"}  \n\n  garbage \n[1,2,3]\n{"type":"Y","message":"b"}'
    parsed = parse_buf_lint_output(out)
    # The bare-array line is valid JSON but not a finding object → skipped.
    assert [p["type"] for p in parsed] == ["X", "Y"]


# ===========================================================================
# run_buf_lint — driven with a fake toolchain runner (no real buf)
# ===========================================================================


@dataclass
class _FakeRunResult:
    stdout: str = ""
    stderr: str = ""
    exit_code: int = 0


@dataclass
class _Call:
    spec: ToolSpec
    args: List[str]
    scratch: Dict[str, str] = field(default_factory=dict)


class _FakeLintRunner:
    """A toolchain-runner double for ``buf lint``.

    Snapshots the materialised scratch module, then returns a fixed result or raises a fixed
    error — exactly the two outcomes :func:`run_buf_lint` must handle.
    """

    def __init__(
        self,
        *,
        result: Optional[_FakeRunResult] = None,
        error: Optional[Exception] = None,
    ) -> None:
        self._result = result if result is not None else _FakeRunResult()
        self._error = error
        self.calls: List[_Call] = []

    async def run_spec(
        self,
        spec: ToolSpec,
        args: Sequence[str] = (),
        *,
        timeout: Optional[float] = None,
        policy: Any = None,
        **_: Any,
    ) -> _FakeRunResult:
        args = list(args)
        base = Path(args[0])
        scratch = {
            str(p.relative_to(base)): p.read_text(encoding="utf-8")
            for p in sorted(base.rglob("*"))
            if p.is_file()
        }
        self.calls.append(_Call(spec=spec, args=args, scratch=scratch))
        if self._error is not None:
            raise self._error
        return self._result


_SAMPLE_PROTO = ProtoFile(
    path="user/user.proto",
    content='syntax = "proto3";\npackage user;\nmessage User { string id = 1; }\n',
)


async def test_run_buf_lint_clean_exit_returns_no_findings() -> None:
    runner = _FakeLintRunner(result=_FakeRunResult(stdout="", exit_code=0))
    assert await run_buf_lint([_SAMPLE_PROTO], runner=runner) == []


async def test_run_buf_lint_materializes_lint_module() -> None:
    runner = _FakeLintRunner()
    await run_buf_lint([_SAMPLE_PROTO], runner=runner)
    call = runner.calls[0]
    assert call.spec.key == BUF_TOOL_KEY
    assert call.spec.base_args == ("lint",)
    assert call.args[1] == "--error-format=json"
    # The scratch module carried the proto and a lint-enabled buf.yaml (STANDARD + COMMENTS).
    assert call.scratch["user/user.proto"] == _SAMPLE_PROTO.content
    assert call.scratch["buf.yaml"] == BUF_LINT_MODULE_YAML
    assert "COMMENTS" in call.scratch["buf.yaml"]


async def test_run_buf_lint_returns_violations_on_exit_100() -> None:
    stdout = '{"path":"user/user.proto","start_line":2,"type":"PACKAGE_VERSION_SUFFIX","message":"bad"}'
    runner = _FakeLintRunner(
        error=ToolExecutionError(BUF_TOOL_KEY, 100, stdout, "")
    )
    findings = await run_buf_lint([_SAMPLE_PROTO], runner=runner)
    assert [f["type"] for f in findings] == ["PACKAGE_VERSION_SUFFIX"]


async def test_run_buf_lint_build_failure_raises() -> None:
    # Non-zero exit with no parseable findings (a syntax error) is operational, not violations.
    runner = _FakeLintRunner(
        error=ToolExecutionError(BUF_TOOL_KEY, 1, "", "a.proto:1:1: syntax error")
    )
    with pytest.raises(ProtoLintError, match="failed to process"):
        await run_buf_lint([_SAMPLE_PROTO], runner=runner)


async def test_run_buf_lint_unavailable_and_timeout_map_to_lint_error() -> None:
    unavailable = _FakeLintRunner(error=ToolNotAvailableError(BUF_TOOL_KEY, "buf"))
    with pytest.raises(ProtoLintError, match="not available"):
        await run_buf_lint([_SAMPLE_PROTO], runner=unavailable)

    timed_out = _FakeLintRunner(error=ToolTimeoutError(BUF_TOOL_KEY, 5.0))
    with pytest.raises(ProtoLintError, match="timed out"):
        await run_buf_lint([_SAMPLE_PROTO], runner=timed_out)


async def test_run_buf_lint_empty_files_raises() -> None:
    with pytest.raises(ProtoLintError, match="At least one"):
        await run_buf_lint([], runner=_FakeLintRunner())


async def test_run_buf_lint_rejects_unsafe_path() -> None:
    bad = ProtoFile(path="../escape.proto", content="syntax = \"proto3\";")
    with pytest.raises(ProtoCompileError):
        await run_buf_lint([bad], runner=_FakeLintRunner())


# ===========================================================================
# Merge entry points
# ===========================================================================


def test_lint_protobuf_result_degrades_without_buf_report() -> None:
    fds = descriptor_pb2.FileDescriptorSet()
    f = _file(fds, "a.proto", "acme.user")  # unversioned → a native finding
    msg = f.message_type.add()
    msg.name = "M"
    _scalar(msg, "id", 1)
    result = lint_protobuf_result(_model(fds))
    assert _native_rules(result)  # native rules still ran
    assert all(not f.rule.startswith(BUF_LINT_RULE_PREFIX) for f in result.findings)


def test_lint_protobuf_result_merges_buf_into_score() -> None:
    model = _model(_clean_descriptor_set())
    clean = lint_protobuf_result(model)
    report = [
        {
            "path": "user/user.proto",
            "start_line": 1,
            "start_column": 1,
            "type": "PACKAGE_VERSION_SUFFIX",
            "message": "package should be versioned",
        }
    ]
    merged = lint_protobuf_result(model, report)
    rules = {f.rule for f in merged.findings}
    assert f"{BUF_LINT_RULE_PREFIX}.package_version_suffix" in rules
    assert merged.score < clean.score  # the buf finding lowered the score


# ===========================================================================
# End-to-end: the real bundled buf through the real runner (gated)
# ===========================================================================

_BUF_AVAILABLE = bool(getattr(probe_tool(BUF_TOOL_KEY), "available", False))


def _load_fixture_files(*relpaths: str) -> List[ProtoFile]:
    return [
        ProtoFile(path=rel, content=(_FIXTURES / rel).read_text(encoding="utf-8"))
        for rel in relpaths
    ]


@pytest.mark.skipif(not _BUF_AVAILABLE, reason="bundled buf not resolvable in this environment")
async def test_lint_protobuf_end_to_end_scores_a_sample() -> None:
    files = _load_fixture_files("common/types.proto", "user/user_service.proto")
    result = await lint_protobuf(files)
    assert isinstance(result, LintResult)
    assert 0 <= result.score <= 100
    # The fixtures' package is unversioned (``acme.user``), so both the native rule and buf's own
    # PACKAGE_VERSION_SUFFIX should surface — the two halves merging into one scored report.
    rules = {f.rule for f in result.findings}
    assert "protobuf.package-version-suffix" in rules
    assert any(r.startswith(BUF_LINT_RULE_PREFIX) for r in rules)
