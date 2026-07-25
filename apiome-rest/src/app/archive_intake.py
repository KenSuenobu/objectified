"""Archive (zip/tar) upload intake — MFI-29.1 (#4388).

Accepts ``.zip`` / ``.tar.gz`` / ``.tgz`` uploads across REST, CLI, and UI intake.
Unpacks under sandbox discipline (entry count, total/per-file size caps, depth cap,
no path traversal) before handing a :class:`~app.fileset.IntakeFileset` to adapters.

Single-file behaviour is unchanged — only payloads recognised as archives are unpacked.
"""

from __future__ import annotations

import io
import re
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Dict, List, Mapping, Optional, Sequence, Tuple

from .config import settings
from .format_detection import FormatDetection, detect_format
from .import_source import DetectionInput
from .intake_paths import IntakePathError, normalised_member_name, validated_intake_path

__all__ = [
    "ARCHIVE_SUFFIXES",
    "ArchiveIntakeError",
    "ArchivePolicy",
    "UnpackedArchive",
    "archive_policy_from_settings",
    "detect_archive_format",
    "is_archive_filename",
    "is_archive_payload",
    "unpack_archive",
]

ARCHIVE_SUFFIXES: Tuple[str, ...] = (".zip", ".tar.gz", ".tgz", ".tar")

# Archive members we never ingest (resource forks, VCS metadata).
_SKIP_PREFIXES: Tuple[str, ...] = ("__MACOSX/", ".git/")
_SKIP_BASENAMES: Tuple[str, ...] = (".DS_Store", "Thumbs.db")

# Extensions worth sniffing when auto-detecting a root document inside an archive.
_ROOT_CANDIDATE_SUFFIXES: Tuple[str, ...] = (
    ".proto",
    ".graphql",
    ".gql",
    ".yaml",
    ".yml",
    ".json",
    ".asyncapi.yaml",
    ".asyncapi.yml",
    ".asyncapi.json",
)


class ArchiveIntakeError(ValueError):
    """An archive could not be unpacked or its root could not be resolved."""


@dataclass(frozen=True)
class ArchivePolicy:
    """Sandbox limits applied while unpacking an archive."""

    max_entries: int
    max_total_bytes: int
    max_file_bytes: int
    max_depth: int


@dataclass(frozen=True)
class UnpackedArchive:
    """The validated, decoded members of one archive."""

    members: Dict[str, str]
    root_path: str
    detection: FormatDetection
    ambiguous_roots: Tuple[str, ...] = ()


def archive_policy_from_settings() -> ArchivePolicy:
    """Build the active policy from deployment settings."""
    return ArchivePolicy(
        max_entries=settings.archive_max_entries,
        max_total_bytes=settings.archive_max_total_bytes,
        max_file_bytes=settings.archive_max_file_bytes,
        max_depth=settings.archive_max_depth,
    )


def is_archive_filename(filename: Optional[str]) -> bool:
    """Return whether *filename* names a supported archive type."""
    if not filename:
        return False
    lower = filename.replace("\\", "/").rsplit("/", 1)[-1].lower()
    if lower.endswith(".tar.gz") or lower.endswith(".tgz"):
        return True
    return lower.endswith((".zip", ".tar"))


def is_archive_payload(raw: bytes, filename: Optional[str] = None) -> bool:
    """Return whether *raw* bytes (optionally hinted by *filename*) are an archive."""
    if filename and is_archive_filename(filename):
        return True
    if len(raw) >= 4 and raw[:2] == b"PK":
        return True
    if len(raw) >= 2 and raw[:2] == b"\x1f\x8b":
        return True
    if len(raw) >= 262 and raw[257:262] == b"ustar":
        return True
    return False


def _should_skip_member(name: str) -> bool:
    normalised = name.replace("\\", "/").lstrip("./")
    if not normalised or normalised.endswith("/"):
        return True
    for prefix in _SKIP_PREFIXES:
        if normalised.startswith(prefix):
            return True
    base = normalised.rsplit("/", 1)[-1]
    if base.startswith("."):
        return True
    if base in _SKIP_BASENAMES:
        return True
    return False


def _validate_member_path(name: str, *, max_depth: int, label: str) -> str:
    try:
        pure = validated_intake_path(name, max_depth=max_depth, label=label)
    except IntakePathError as exc:
        raise ArchiveIntakeError(str(exc)) from exc
    return normalised_member_name(pure)


def _decode_member_bytes(data: bytes, *, path: str, max_file_bytes: int, where: str) -> str:
    if len(data) > max_file_bytes:
        raise ArchiveIntakeError(
            f"Archive member {path!r} exceeds the {max_file_bytes}-byte per-file limit{where}"
        )
    return data.decode("utf-8", errors="replace")


def _read_zip_member(
    archive: zipfile.ZipFile,
    info: zipfile.ZipInfo,
    *,
    name: str,
    policy: ArchivePolicy,
    where: str,
) -> bytes:
    """Decompress one zip member with a hard ceiling on bytes materialized.

    ``ZipFile.read`` trusts nothing but also stops at nothing: it decompresses the
    whole member into memory, so a header that under-declares its size (the
    classic zip bomb) is only caught *after* the damage. Reading through the
    member stream with an explicit cap keeps a lying header bounded to one byte
    over the limit (IXH-1.4).

    Args:
        archive: The open zip archive.
        info: The member being read.
        name: The validated member path, for error messages.
        policy: Limits in force.
        where: Source-label suffix for error messages.

    Returns:
        The member's decompressed bytes.

    Raises:
        ArchiveIntakeError: If the member decompresses past the per-file limit, or
            its stored data is corrupt (bad CRC, truncated deflate stream).
    """
    ceiling = policy.max_file_bytes + 1
    try:
        with archive.open(info) as stream:
            data = stream.read(ceiling)
    except (zipfile.BadZipFile, EOFError, OSError, ValueError) as exc:
        # BadZipFile here means the member failed its own CRC/size check.
        raise ArchiveIntakeError(
            f"Archive member {name!r} could not be decompressed{where}: {exc}"
        ) from exc
    if len(data) >= ceiling:
        raise ArchiveIntakeError(
            f"Archive member {name!r} decompresses past the {policy.max_file_bytes}-byte "
            f"per-file limit{where} (its declared size was {info.file_size} bytes)"
        )
    return data


def _unpack_zip(
    raw: bytes,
    *,
    policy: ArchivePolicy,
    where: str,
) -> Dict[str, str]:
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise ArchiveIntakeError(f"Archive is not a valid .zip file{where}") from exc

    members: Dict[str, str] = {}
    total = 0
    try:
        infos = archive.infolist()
        if len(infos) > policy.max_entries:
            raise ArchiveIntakeError(
                f"Archive exceeds the {policy.max_entries}-entry limit{where}"
            )
        for info in infos:
            if info.is_dir():
                continue
            raw_name = info.filename
            if _should_skip_member(raw_name):
                continue
            # Reject symlink / external attributes that indicate non-regular files.
            if info.external_attr & 0o170000 == 0o120000:
                raise ArchiveIntakeError(
                    f"Archive member {raw_name!r} is a symlink and is not allowed{where}"
                )
            name = _validate_member_path(raw_name, max_depth=policy.max_depth, label="Archive member")
            if name in members:
                raise ArchiveIntakeError(f"Archive defines member {name!r} more than once{where}")
            # The declared size is attacker-controlled, so it is only a cheap first
            # filter: reject an oversized *claim* before decompressing anything.
            if info.file_size > policy.max_file_bytes:
                raise ArchiveIntakeError(
                    f"Archive member {name!r} declares {info.file_size} bytes, over the "
                    f"{policy.max_file_bytes}-byte per-file limit{where}"
                )
            total += info.file_size
            if total > policy.max_total_bytes:
                raise ArchiveIntakeError(
                    f"Archive exceeds the {policy.max_total_bytes}-byte uncompressed limit{where}"
                )
            # Then decompress with a hard read ceiling, so a member whose header
            # lies about its size (a zip bomb) cannot materialize past the limit.
            data = _read_zip_member(archive, info, name=name, policy=policy, where=where)
            if len(data) > policy.max_file_bytes:
                raise ArchiveIntakeError(
                    f"Archive member {name!r} exceeds the {policy.max_file_bytes}-byte "
                    f"per-file limit{where}"
                )
            members[name] = _decode_member_bytes(
                data, path=name, max_file_bytes=policy.max_file_bytes, where=where
            )
    finally:
        archive.close()

    if not members:
        raise ArchiveIntakeError(f"Archive contains no usable files{where}")
    return members


class _SkipTarMemberError(Exception):
    """Internal signal: this tar member is not a file and is simply skipped.

    Previously this raised ``tarfile.SkipHeader``, which does not exist — so any
    archive containing a directory entry (that is, almost every real tar) raised
    ``AttributeError`` out of intake instead of skipping the entry. Surfaced by the
    IXH-1.4 adversarial corpus.
    """


def _tar_extract_filter(tarinfo: tarfile.TarInfo, dest: str) -> tarfile.TarInfo:
    """Refuse symlinks, hard links, devices, and absolute paths in tar members.

    Args:
        tarinfo: The member header being screened.
        dest: Unused; kept so the signature matches tarfile's filter protocol.

    Returns:
        The member, when it is an acceptable regular file.

    Raises:
        ArchiveIntakeError: For a link, device, or absolute-path member.
        _SkipTarMemberError: For a directory or other non-file entry, which is skipped.
    """
    name = tarinfo.name.replace("\\", "/")
    if tarinfo.issym() or tarinfo.islnk():
        raise ArchiveIntakeError(f"Archive member {name!r} is a link and is not allowed")
    if tarinfo.isdev() or tarinfo.isfifo() or tarinfo.ischr() or tarinfo.isblk():
        raise ArchiveIntakeError(f"Archive member {name!r} is not a regular file")
    if not tarinfo.isfile():
        raise _SkipTarMemberError
    if name.startswith("/") or PurePosixPath(name).is_absolute():
        raise ArchiveIntakeError(f"Archive member {name!r} must be relative")
    return tarinfo


def _unpack_tar(
    raw: bytes,
    *,
    policy: ArchivePolicy,
    where: str,
) -> Dict[str, str]:
    mode = "r:gz" if raw[:2] == b"\x1f\x8b" else "r:"
    try:
        archive = tarfile.open(fileobj=io.BytesIO(raw), mode=mode)
    except tarfile.TarError as exc:
        raise ArchiveIntakeError(f"Archive is not a valid tar archive{where}") from exc

    members: Dict[str, str] = {}
    total = 0
    try:
        tar_members = archive.getmembers()
        if len(tar_members) > policy.max_entries:
            raise ArchiveIntakeError(
                f"Archive exceeds the {policy.max_entries}-entry limit{where}"
            )
        for tarinfo in tar_members:
            try:
                filtered = _tar_extract_filter(tarinfo, "")
            except _SkipTarMemberError:
                continue
            raw_name = filtered.name
            if _should_skip_member(raw_name):
                continue
            name = _validate_member_path(raw_name, max_depth=policy.max_depth, label="Archive member")
            if name in members:
                raise ArchiveIntakeError(f"Archive defines member {name!r} more than once{where}")
            # Same two-stage check as the zip path: reject an oversized declared
            # size cheaply, then bound what the stream is actually allowed to yield.
            if filtered.size > policy.max_file_bytes:
                raise ArchiveIntakeError(
                    f"Archive member {name!r} declares {filtered.size} bytes, over the "
                    f"{policy.max_file_bytes}-byte per-file limit{where}"
                )
            total += filtered.size
            if total > policy.max_total_bytes:
                raise ArchiveIntakeError(
                    f"Archive exceeds the {policy.max_total_bytes}-byte uncompressed limit{where}"
                )
            ceiling = policy.max_file_bytes + 1
            try:
                extracted = archive.extractfile(filtered)
                if extracted is None:
                    continue
                data = extracted.read(ceiling)
            except tarfile.TarError as exc:
                raise ArchiveIntakeError(
                    f"Archive member {name!r} could not be extracted{where}: {exc}"
                ) from exc
            if len(data) >= ceiling:
                raise ArchiveIntakeError(
                    f"Archive member {name!r} expands past the {policy.max_file_bytes}-byte "
                    f"per-file limit{where} (its declared size was {filtered.size} bytes)"
                )
            members[name] = _decode_member_bytes(
                data, path=name, max_file_bytes=policy.max_file_bytes, where=where
            )
    finally:
        archive.close()

    if not members:
        raise ArchiveIntakeError(f"Archive contains no usable files{where}")
    return members


def unpack_archive(
    raw: bytes,
    *,
    source_label: Optional[str] = None,
    root_path: Optional[str] = None,
    policy: Optional[ArchivePolicy] = None,
) -> UnpackedArchive:
    """Unpack a zip/tar archive into validated text members and resolve the root document.

    Args:
        raw: Raw archive bytes.
        source_label: Optional archive filename for clearer errors.
        root_path: Explicit module-relative root path (CLI ``--root`` / UI picker).
        policy: Sandbox limits; defaults to :func:`archive_policy_from_settings`.

    Returns:
        :class:`UnpackedArchive` with every member, the chosen root, and format detection.

    Raises:
        ArchiveIntakeError: Invalid archive, policy violation, ambiguous root without
            an explicit ``root_path``, or no detectable root candidate.
    """
    where = f" ({source_label})" if source_label else ""
    active = policy or archive_policy_from_settings()
    if len(raw) > active.max_total_bytes:
        raise ArchiveIntakeError(
            f"Archive exceeds the {active.max_total_bytes}-byte compressed limit{where}"
        )

    if raw[:2] == b"PK":
        members = _unpack_zip(raw, policy=active, where=where)
    else:
        members = _unpack_tar(raw, policy=active, where=where)

    root, detection, ambiguous = _resolve_root(members, explicit_root=root_path, where=where)
    return UnpackedArchive(
        members=members,
        root_path=root,
        detection=detection,
        ambiguous_roots=ambiguous,
    )


_PROTO_IMPORT_RE = re.compile(r"""import\s+"(.+?)"\s*;""")


def _member_import_boost(path: str, text: str, members: Mapping[str, str]) -> float:
    """Prefer proto entrypoints that define services and import sibling modules."""
    boost = 0.0
    if "service " in text:
        boost += 0.25
    for match in _PROTO_IMPORT_RE.finditer(text):
        imported = match.group(1).replace("\\", "/")
        if imported in members and imported != path:
            boost += 0.05
    return boost


def _root_candidates(members: Mapping[str, str]) -> List[str]:
    paths = sorted(members)
    scored: List[Tuple[float, str]] = []
    for path in paths:
        lower = path.lower()
        if not any(lower.endswith(suffix) for suffix in _ROOT_CANDIDATE_SUFFIXES):
            continue
        detection = detect_format(
            DetectionInput(text=members[path], filename=path),
        )
        if not detection.matched or detection.detected is None:
            continue
        score = detection.detected.confidence + _member_import_boost(
            path, members[path], members
        )
        scored.append((score, path))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [path for _, path in scored]


def _resolve_root(
    members: Mapping[str, str],
    *,
    explicit_root: Optional[str],
    where: str,
) -> Tuple[str, FormatDetection, Tuple[str, ...]]:
    if explicit_root:
        normalised = _validate_member_path(
            explicit_root, max_depth=archive_policy_from_settings().max_depth, label="Root"
        )
        if normalised not in members:
            raise ArchiveIntakeError(
                f"Archive root {normalised!r} was not found among the unpacked members{where}"
            )
        detection = detect_format(
            DetectionInput(text=members[normalised], filename=normalised),
        )
        if not detection.matched:
            raise ArchiveIntakeError(
                f"Could not detect a supported format for archive root {normalised!r}{where}"
            )
        return normalised, detection, ()

    candidates = _root_candidates(members)
    if not candidates:
        raise ArchiveIntakeError(
            f"Archive contains no document with a recognisable import format{where}"
        )
    if len(candidates) == 1:
        root = candidates[0]
        detection = detect_format(DetectionInput(text=members[root], filename=root))
        return root, detection, ()

    first = candidates[0]
    second = candidates[1]
    det_first = detect_format(DetectionInput(text=members[first], filename=first))
    det_second = detect_format(DetectionInput(text=members[second], filename=second))
    if (
        det_first.detected
        and det_second.detected
        and abs(det_first.detected.confidence - det_second.detected.confidence) < 0.15
        and det_first.detected.format != det_second.detected.format
    ):
        raise ArchiveIntakeError(
            "Archive root is ambiguous — choose a root document explicitly "
            f"(candidates: {', '.join(candidates[:5])}){where}"
        )
    root = candidates[0]
    detection = detect_format(DetectionInput(text=members[root], filename=root))
    return root, detection, tuple(candidates[1:5])


def detect_archive_format(
    raw: bytes,
    *,
    filename: Optional[str] = None,
    root_path: Optional[str] = None,
) -> UnpackedArchive:
    """Unpack *raw* and return detection metadata (for ``POST /import/detect``)."""
    if not is_archive_payload(raw, filename):
        raise ArchiveIntakeError("Payload is not a supported archive (.zip / .tar.gz / .tgz)")
    return unpack_archive(raw, source_label=filename, root_path=root_path)
