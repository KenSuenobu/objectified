"""
Filter GET version (pull) JSON by logical sections for headless/CI clients (#2591 / P2-09).

Wire keys match ``VersionSchema.model_dump(by_alias=True)``. The same strong ETag applies to full
and partial representations: it identifies the revision, not the selected field set (see #2568).
"""

from __future__ import annotations

from typing import Any, Dict, Mapping, Optional, Set, Tuple

# JSON keys as produced by VersionSchema.model_dump(by_alias=True, mode="json").
SECTION_FIELD_KEYS: dict[str, frozenset[str]] = {
    "core": frozenset({"id", "project_id", "version_id"}),
    "commit": frozenset(
        {
            "shortMessage",
            "changelog",
            "author",
            "message",
            "externalRef",
        }
    ),
    "publish": frozenset(
        {
            "visibility",
            "published",
            "published_at",
            "publishedImmutable",
            "enabled",
        }
    ),
    "mock": frozenset({"mockEnabled", "mockPrivate", "mockBaseUrl"}),
    "lineage": frozenset(
        {
            "parent_version_id",
            "merge_parent_version_id",
            "forkedFromRevisionId",
            "upstreamProjectId",
            "forkSourceVersionLabel",
            "forkSourceProjectName",
            "upstreamProjectName",
            "sourceCommitSha",
            "sourceCommittedAt",
        }
    ),
    # Stored lint headline (#5259) rides with governance: it is the style-guide-scored signal.
    "governance": frozenset(
        {"revisionLocked", "metadata", "lifecycle", "qualityScore", "qualityGrade"}
    ),
    "creator": frozenset({"creator_id", "creator_name", "creator_email"}),
    "project": frozenset({"project_name", "project_slug"}),
    "timestamps": frozenset({"created_at", "updated_at"}),
}


def section_names() -> frozenset[str]:
    return frozenset(SECTION_FIELD_KEYS.keys())


def _parse_section_tokens(param: Optional[str]) -> Optional[list[str]]:
    if param is None:
        return None
    s = str(param).strip()
    if not s:
        return None
    return [p.strip() for p in s.split(",") if p.strip()]


def resolve_pull_sections(
    include_raw: Optional[str],
    exclude_raw: Optional[str],
) -> Tuple[Optional[Set[str]], Optional[Set[str]]]:
    """
    Parse include/exclude section lists. Exactly one mode: include-only, exclude-only, or neither.
    Raises ValueError on unknown section names or when both include and exclude are set.
    """
    inc = _parse_section_tokens(include_raw)
    exc = _parse_section_tokens(exclude_raw)
    if inc and exc:
        raise ValueError("includeSections and excludeSections cannot both be set")
    valid = section_names()

    def _resolve(names: list[str], label: str) -> Set[str]:
        out: Set[str] = set()
        for raw in names:
            key = raw.strip().lower()
            if key not in valid:
                raise ValueError(
                    f"Unknown section {raw!r} in {label}; "
                    f"expected one or more of: {', '.join(sorted(valid))}"
                )
            out.add(key)
        return out

    if inc:
        return (_resolve(inc, "includeSections"), None)
    if exc:
        return (None, _resolve(exc, "excludeSections"))
    return (None, None)


def all_wire_keys() -> frozenset[str]:
    keys: Set[str] = set()
    for ks in SECTION_FIELD_KEYS.values():
        keys |= set(ks)
    return frozenset(keys)


def filter_version_pull_dump(
    full_dump: Mapping[str, Any],
    *,
    include_sections: Optional[Set[str]],
    exclude_sections: Optional[Set[str]],
) -> Dict[str, Any]:
    """
    Return a copy of ``full_dump`` restricted to the requested sections.
    With no include/exclude, returns ``dict(full_dump)``.
    """
    if not include_sections and not exclude_sections:
        return dict(full_dump)

    core = SECTION_FIELD_KEYS["core"]
    all_keys = all_wire_keys()

    if include_sections:
        keep: Set[str] = set(core)
        for sec in include_sections:
            keep |= SECTION_FIELD_KEYS[sec]
        return {k: v for k, v in full_dump.items() if k in keep}

    drop: Set[str] = set()
    for sec in exclude_sections or set():
        drop |= SECTION_FIELD_KEYS[sec]
    drop -= core
    keep_keys = all_keys - drop
    extra = set(full_dump.keys()) - all_keys
    keep_keys |= extra
    return {k: v for k, v in full_dump.items() if k in keep_keys}
