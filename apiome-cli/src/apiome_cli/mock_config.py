"""The mock configuration document: one reviewable file per version (#5530, MSC-1.4).

The settings that decide what a mock returns — response correlation, scenarios, chaos, fixture
packs — used to be editable only through the ADE. That makes them impossible to diff, impossible
to review in a pull request, and impossible to promote from one version or environment to another
except by hand. For teams that treat contracts as code, that is the missing half of the mock.

This module owns the *document*: how it is built from what the control plane reports, how it is
serialized so that committing it and re-pulling produces no diff, how two of them are compared,
and how a server-side validation error is rendered against the file's own paths instead of as an
opaque JSON blob. It performs no I/O and knows nothing about HTTP, which is what lets the same
functions serve ``pull``, ``push``, ``diff`` and ``preview --file``.

Three properties are worth stating outright, because they are contracts rather than conveniences:

* **The document is whole, not partial.** ``push`` replaces every section it carries, and a
  section a document omits is *cleared*, not left alone. The ``configFormat`` marker is required
  precisely so that no arbitrary JSON file can be pushed into a version by accident.
* **The document is the server's own canonical form, verbatim.** Nothing is pruned or reshaped on
  the way through — not even the explicit ``null``s the API reports for unset optional fields —
  because a mock's canned response body is free-form JSON in which ``null`` is a value. Tidying
  the document would either change what the mock serves or make a re-pull disagree with the file.
* **The document carries no identity.** No tenant, project or version travels in it, so the same
  file can be pushed to a staging version and then to a production one. What it configures is the
  command line's business, not the file's.
"""

from __future__ import annotations

import difflib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

__all__ = [
    "CONFIG_FORMAT",
    "CONFIG_FORMAT_VERSION",
    "SECTION_KEYS",
    "ConfigChange",
    "ConfigDiff",
    "ConfigError",
    "MockConfigError",
    "build_document",
    "diff_documents",
    "document_sections",
    "format_errors",
    "locate_errors",
    "parse_document",
    "read_document",
    "serialize_document",
]

#: Format marker every configuration document must declare. It is what distinguishes "a whole mock
#: configuration, safe to apply wholesale" from "some JSON someone pointed ``--file`` at".
CONFIG_FORMAT = "apiome.mock.config/v1"

#: Revision of :data:`CONFIG_FORMAT`. Bumped only for a change a v1 reader could not survive.
CONFIG_FORMAT_VERSION = 1

#: The configuration sections, in the order they are reported. Every document carries all four,
#: because "absent" and "empty" must be the same thing for a document that replaces wholesale.
SECTION_KEYS: tuple[str, ...] = ("correlation", "scenarios", "chaos", "fixturePacks")

#: Sections that are a map of named entries, so a diff can name what changed inside them.
_NAMED_SECTIONS: frozenset[str] = frozenset({"scenarios", "fixturePacks"})

#: Every key a document may carry. Anything else is a typo the caller wants to hear about, not a
#: field a future version might mean — an unrecognised section would be silently dropped on push.
_DOCUMENT_KEYS: frozenset[str] = frozenset({"configFormat", "configFormatVersion", *SECTION_KEYS})


class MockConfigError(ValueError):
    """A configuration document could not be read, parsed, or understood."""


def build_document(
    *,
    correlation: Any,
    scenarios: Mapping[str, Any],
    chaos: Any,
    fixture_packs: Mapping[str, Any],
) -> dict[str, Any]:
    """Assemble a configuration document from the control plane's four answers.

    Args:
        correlation: The stored ``responseCorrelation`` block, or ``None``.
        scenarios: The stored scenario definitions keyed by name.
        chaos: The stored version-level chaos block, or ``None``.
        fixture_packs: The stored fixture packs keyed by pack name.

    Returns:
        The document, ready for :func:`serialize_document`.
    """
    return {
        "configFormat": CONFIG_FORMAT,
        "configFormatVersion": CONFIG_FORMAT_VERSION,
        "correlation": correlation,
        "scenarios": dict(scenarios),
        "chaos": chaos,
        "fixturePacks": dict(fixture_packs),
    }


def serialize_document(document: Mapping[str, Any]) -> str:
    """Render a document as the canonical text that gets committed.

    Keys are sorted at every depth and the indent is fixed, so the output depends only on the
    *values* the control plane reports and never on the order a mapping happened to be built in.
    That is what makes "pull, commit, pull again" produce no diff, and it is safe because JSON
    object members are unordered — the settings themselves reach the runtime through a JSONB
    column that does not preserve insertion order either.

    Args:
        document: The document to render.

    Returns:
        Canonical JSON text with a trailing newline.
    """
    return json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def parse_document(text: str, *, source: str) -> dict[str, Any]:
    """Parse and check the shape of a configuration document.

    The checks are deliberately about the *envelope* only. Everything inside a section is the
    server's to judge: re-implementing scenario or correlation validation here would create a
    second set of rules free to disagree with the ones that actually apply.

    Args:
        text: The document text.
        source: Where it came from, for error messages.

    Returns:
        The parsed document, with every section present (a missing section reads as empty, which
        is the same thing a whole-document push means by it).

    Raises:
        MockConfigError: The text is not JSON, is not an object, declares a format this reader
            does not understand, or carries a key that is not a section.
    """
    try:
        parsed = json.loads(text)
    except ValueError as exc:
        raise MockConfigError(f"{source} is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise MockConfigError(f"{source} must contain a JSON object, not a {type(parsed).__name__}.")

    declared = parsed.get("configFormat")
    if declared is None:
        raise MockConfigError(
            f'{source} does not declare "configFormat": "{CONFIG_FORMAT}". A mock configuration '
            "document replaces every section of a version's mock settings, so the marker is "
            "required — write one with 'apiome mock config pull'."
        )
    if declared != CONFIG_FORMAT:
        raise MockConfigError(
            f"{source} declares configFormat {declared!r}; this CLI understands '{CONFIG_FORMAT}'."
        )
    version = parsed.get("configFormatVersion", CONFIG_FORMAT_VERSION)
    if version != CONFIG_FORMAT_VERSION:
        raise MockConfigError(
            f"{source} declares configFormatVersion {version!r}; this CLI understands "
            f"{CONFIG_FORMAT_VERSION}. Upgrade the CLI, or re-pull the document."
        )

    unknown = sorted(set(parsed) - _DOCUMENT_KEYS)
    if unknown:
        raise MockConfigError(
            f"{source} has unknown keys: {', '.join(unknown)}. Sections are: "
            f"{', '.join(sorted(SECTION_KEYS))}."
        )

    for key in ("scenarios", "fixturePacks"):
        value = parsed.get(key)
        if value is not None and not isinstance(value, dict):
            raise MockConfigError(f"{source}: '{key}' must be an object keyed by name.")
    for key in ("correlation", "chaos"):
        value = parsed.get(key)
        if value is not None and not isinstance(value, dict):
            raise MockConfigError(f"{source}: '{key}' must be an object, or null.")

    return build_document(
        correlation=parsed.get("correlation"),
        scenarios=parsed.get("scenarios") or {},
        chaos=parsed.get("chaos"),
        fixture_packs=parsed.get("fixturePacks") or {},
    )


def read_document(path: Path) -> dict[str, Any]:
    """Read and parse a configuration document from disk.

    Args:
        path: The file to read.

    Returns:
        The parsed document.

    Raises:
        MockConfigError: The file cannot be read, or is not a valid document.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise MockConfigError(f"Cannot read {path}: {exc}") from exc
    return parse_document(text, source=str(path))


def document_sections(document: Mapping[str, Any]) -> dict[str, Any]:
    """Return the four section values a push applies, keyed by section name.

    Args:
        document: A parsed document.

    Returns:
        ``{"correlation": …, "scenarios": …, "chaos": …, "fixturePacks": …}``.
    """
    return {key: document.get(key) for key in SECTION_KEYS}


@dataclass(frozen=True)
class ConfigChange:
    """One difference a push would make.

    Attributes:
        section: The section it lives in (``scenarios``, ``correlation``, …).
        name: The named entry inside that section, or ``None`` for a whole-section change.
        change: ``added``, ``removed``, or ``modified``, from the *server's* point of view — what
            pushing the file would do to the version.
    """

    section: str
    name: str | None
    change: str

    @property
    def path(self) -> str:
        """The document path this change touches, as it is written in the file."""
        return _entry_path(self.section, self.name)

    def as_dict(self) -> dict[str, Any]:
        """Render the change for ``--json`` output."""
        return {"section": self.section, "name": self.name, "path": self.path, "change": self.change}


@dataclass(frozen=True)
class ConfigDiff:
    """What a push would change, both as a list and as a unified diff.

    Attributes:
        changes: One entry per added, removed, or modified section entry.
        unified: A unified diff of the two canonical documents, empty when they are identical.
    """

    changes: tuple[ConfigChange, ...]
    unified: str

    @property
    def changed(self) -> bool:
        """Whether pushing the file would change anything at all."""
        return bool(self.changes)

    def as_dict(self) -> dict[str, Any]:
        """Render the whole comparison for ``--json`` output."""
        return {
            "changed": self.changed,
            "changes": [change.as_dict() for change in self.changes],
            "diff": self.unified,
        }


def diff_documents(
    remote: Mapping[str, Any],
    local: Mapping[str, Any],
    *,
    remote_label: str = "server",
    local_label: str = "file",
) -> ConfigDiff:
    """Compare the stored configuration against a local document.

    Args:
        remote: The document as pulled from the control plane.
        local: The document read from disk.
        remote_label: Label for the ``---`` side of the unified diff.
        local_label: Label for the ``+++`` side of the unified diff.

    Returns:
        The changes a push would make, from the server's point of view.
    """
    changes: list[ConfigChange] = []
    for section in SECTION_KEYS:
        before = remote.get(section)
        after = local.get(section)
        if section in _NAMED_SECTIONS:
            changes.extend(_named_section_changes(section, before or {}, after or {}))
        elif before != after:
            changes.append(ConfigChange(section, None, _whole_change(before, after)))

    unified = ""
    if changes:
        unified = "".join(
            difflib.unified_diff(
                serialize_document(remote).splitlines(keepends=True),
                serialize_document(local).splitlines(keepends=True),
                fromfile=remote_label,
                tofile=local_label,
            )
        )
    return ConfigDiff(tuple(changes), unified)


def _whole_change(before: Any, after: Any) -> str:
    """Classify a whole-section change (a section is present or it is not)."""
    if before is None:
        return "added"
    if after is None:
        return "removed"
    return "modified"


def _named_section_changes(
    section: str,
    before: Mapping[str, Any],
    after: Mapping[str, Any],
) -> list[ConfigChange]:
    """Compare two ``{name: entry}`` sections entry by entry, in name order."""
    changes: list[ConfigChange] = []
    for name in sorted(set(before) | set(after)):
        if name not in before:
            changes.append(ConfigChange(section, name, "added"))
        elif name not in after:
            changes.append(ConfigChange(section, name, "removed"))
        elif before[name] != after[name]:
            changes.append(ConfigChange(section, name, "modified"))
    return changes


@dataclass(frozen=True)
class ConfigError:
    """One server-side validation error, placed in the document that caused it.

    Attributes:
        path: Where in the document the error belongs, or ``None`` when the sentence names no
            location this reader recognises (it is still reported, verbatim).
        message: The server's sentence, with the location prefix removed when ``path`` carries it.
    """

    path: str | None
    message: str

    def as_dict(self) -> dict[str, Any]:
        """Render the error for ``--json`` output."""
        return {"path": self.path, "message": self.message}


def _quote(value: str) -> str:
    """Render one map key as it is written in the document."""
    return json.dumps(value, ensure_ascii=False)


def _entry_path(section: str, name: str | None) -> str:
    """Build the document path of a section, or of one named entry inside it."""
    return section if name is None else f"{section}[{_quote(name)}]"


#: Ordered (pattern, path template) pairs mapping the control plane's validation sentences onto
#: document paths. The sentences are stable, human-readable and prefixed with their own location —
#: ``Scenario 'outage', operation 'GET /pets'`` — so the mapping is a transcription of that prefix
#: rather than a second model of the settings. Order matters: the most specific prefix wins, and
#: anything unmatched is reported verbatim rather than guessed at.
_ERROR_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"^Correlation, operation '(?P<op>.+?)', pointer '(?P<ptr>.*?)': (?P<msg>.*)$", re.S),
        "correlation.operations[{op}][{ptr}]",
    ),
    (
        re.compile(r"^Correlation, operation '(?P<op>.+?)': (?P<msg>.*)$", re.S),
        "correlation.operations[{op}]",
    ),
    (re.compile(r"^Correlation: (?P<msg>.*)$", re.S), "correlation"),
    (
        re.compile(r"^Scenario '(?P<name>.+?)' chaos, operation '(?P<op>.+?)': (?P<msg>.*)$", re.S),
        "scenarios[{name}].chaos.operations[{op}]",
    ),
    (
        re.compile(r"^Scenario '(?P<name>.+?)' chaos: (?P<msg>.*)$", re.S),
        "scenarios[{name}].chaos",
    ),
    (
        re.compile(r"^Scenario '(?P<name>.+?)', operation '(?P<op>.+?)': (?P<msg>.*)$", re.S),
        "scenarios[{name}].operations[{op}]",
    ),
    (re.compile(r"^Scenario '(?P<name>.+?)': (?P<msg>.*)$", re.S), "scenarios[{name}]"),
    (re.compile(r"^Scenario name '(?P<name>.+?)' (?P<msg>is invalid.*)$", re.S), "scenarios[{name}]"),
    (
        re.compile(
            r"^Pack '(?P<name>.+?)' collection '(?P<path>.+?)'\[(?P<index>\d+)\]: (?P<msg>.*)$", re.S
        ),
        "fixturePacks[{name}].collections[{path}][{index}]",
    ),
    (
        re.compile(r"^Pack '(?P<name>.+?)' collection '(?P<path>.+?)': (?P<msg>.*)$", re.S),
        "fixturePacks[{name}].collections[{path}]",
    ),
    (re.compile(r"^Pack '(?P<name>.+?)': (?P<msg>.*)$", re.S), "fixturePacks[{name}]"),
    (
        re.compile(r"^Pack '(?P<name>.+?)' (?P<msg>(?:has|must|declares|exceeds).*)$", re.S),
        "fixturePacks[{name}]",
    ),
    (re.compile(r"^Pack name '(?P<name>.+?)' (?P<msg>is invalid.*)$", re.S), "fixturePacks[{name}]"),
    (
        re.compile(r"^Chaos, operation '(?P<op>.+?)': (?P<msg>.*)$", re.S),
        "chaos.operations[{op}]",
    ),
    (re.compile(r"^Chaos: (?P<msg>.*)$", re.S), "chaos"),
    (re.compile(r"^(?P<msg>At most \d+ scenarios .*)$", re.S), "scenarios"),
    (re.compile(r"^(?P<msg>Scenario definitions are too large.*)$", re.S), "scenarios"),
    (re.compile(r"^(?P<msg>At most \d+ fixture packs .*)$", re.S), "fixturePacks"),
    (re.compile(r"^(?P<msg>Fixture packs must be .*)$", re.S), "fixturePacks"),
)


def locate_errors(errors: Iterable[Any]) -> list[ConfigError]:
    """Place each server validation sentence at the document path it is about.

    A 422 from a mock-settings route is a list of sentences, each already prefixed with the
    scenario, pack, operation or pointer it concerns. Reprinting that list is not much use to
    someone looking at a 400-line configuration file; naming the path is. A sentence whose prefix
    is not recognised is reported unchanged rather than filed under a guess.

    Args:
        errors: The ``detail.errors`` list from a 422 response (non-string entries are rendered).

    Returns:
        One :class:`ConfigError` per input entry, in the order the server reported them.
    """
    located: list[ConfigError] = []
    for raw in errors:
        sentence = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False, sort_keys=True)
        located.append(_locate_error(sentence))
    return located


def _locate_error(sentence: str) -> ConfigError:
    """Match one sentence against the known location prefixes."""
    for pattern, template in _ERROR_PATTERNS:
        match = pattern.match(sentence)
        if match is None:
            continue
        groups = match.groupdict()
        path = template.format(
            **{key: _quote(value) if key != "index" else value for key, value in groups.items() if key != "msg"}
        )
        return ConfigError(path, groups.get("msg", sentence).strip())
    return ConfigError(None, sentence)


def format_errors(errors: Sequence[ConfigError], *, source: str) -> list[str]:
    """Render located errors as the lines ``push`` prints to stderr.

    Args:
        errors: The located errors.
        source: The document they belong to, named once at the top.

    Returns:
        Lines to print, in order.
    """
    lines = [f"{source} was rejected ({len(errors)} problem{'s' if len(errors) != 1 else ''}):"]
    for error in errors:
        lines.append(f"  {error.path or '(document)'}")
        lines.append(f"      {error.message}")
    return lines
