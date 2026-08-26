"""Plan fingerprints: refuse to apply a batch that drifted since it was reviewed (BLK-1.3).

Verify-then-apply only means something if the thing applied is the thing verified. The bulk
submit endpoint re-plans its payload server-side, and identical bytes always partition
identically — but the *reconciliation* half of a plan is a statement about the tenant, and the
tenant moves. Between the moment a reviewer read "12 items · 9 new versions · 3 new projects"
and the moment they pressed apply, a colleague may have created the project item 4 was going
to mint, or added the very version item 7 proposed. Re-planning silently would then import
something nobody reviewed.

So the plan hands back a **fingerprint** and the apply hands it straight back:

.. code-block:: text

    plan  ──► resolutions ──► encode_plan_fingerprint ──► token
                                                            │  (client echoes it verbatim)
    apply ──► resolutions ──► detect_plan_drift ◄────────────┘  ──► [] or refuse the batch

What the token holds
--------------------
Each reviewed item's decision — ``key``, resolution, matched project id, proposed version —
compressed and base64url'd behind a version prefix. It is **opaque to clients**: nothing may
parse it, and its encoding may change behind the prefix. It carries the decisions themselves
rather than a digest of them for one reason: a digest can only say *that* a plan drifted, and
the ticket's requirement is that the drift is **described per item**. A reviewer told "your
plan is stale" has to re-read twelve rows to find the one that moved; a reviewer told "item 7
was going to append 1.4.0 and would now append 1.5.0" is told what changed.

Comparison is a dict lookup per item, so checking a stale plan costs nothing next to the
re-plan that produced it.

Scope of the comparison
-----------------------
A submit naming explicit ``keys`` is only acting on those, so only those are compared: an item
the batch will not touch cannot make its apply wrong. A submit with no ``keys`` means "import
every planned item", so the item *set* is part of what was reviewed and an item that appeared
or vanished is itself drift.

Nothing here reads the database, and a fingerprint is never stored: the batch stays stateless,
exactly as its job ids do.
"""

from __future__ import annotations

import base64
import binascii
import json
import zlib
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence

__all__ = [
    "TARGET_PLAN_STALE",
    "PlanDrift",
    "ReviewedItem",
    "decode_plan_fingerprint",
    "describe_reviewed_item",
    "detect_plan_drift",
    "encode_plan_fingerprint",
]

#: The plan a batch was applied from no longer describes what would happen.
TARGET_PLAN_STALE = "TARGET_PLAN_STALE"

#: Version prefix of the token. Encoded payloads are only ever read back by the server, so a
#: future encoding bumps this and older tokens are rejected as unrecognised rather than
#: misread — which fails closed, the correct direction for a staleness check.
_PREFIX = "bp1."

#: Refuse to decompress a token that expands beyond what the batch ceiling could ever produce.
#: A hostile client could otherwise hand over a few kilobytes that inflate to gigabytes.
_MAX_DECODED_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True)
class ReviewedItem:
    """One item's decision as the reviewer saw it.

    Attributes:
        key: The plan item key.
        resolution: What the plan said would happen (``append-version`` / ``create-project``
            / ``unresolved``).
        project_id: The matched project's id, or ``""`` when the item matched nothing.
        version_id: The version label the plan proposed.
    """

    key: str
    resolution: str
    project_id: str
    version_id: str

    def as_row(self) -> List[str]:
        """This item as the compact list the token encodes."""
        return [self.key, self.resolution, self.project_id, self.version_id]


def describe_reviewed_item(item: Optional[ReviewedItem]) -> str:
    """Render one decision as the phrase a drift message compares.

    Args:
        item: The decision, or ``None`` when the item was absent.

    Returns:
        For example ``"append-version onto project 9f2c… at 1.4.0"``, or ``"not in the plan"``.
    """
    if item is None:
        return "not in the plan"
    if item.project_id:
        return f"{item.resolution} onto project {item.project_id} at {item.version_id}"
    return f"{item.resolution} at {item.version_id}"


def encode_plan_fingerprint(items: Sequence[ReviewedItem]) -> str:
    """Mint the token a plan hands back, for the apply to echo.

    Args:
        items: Every planned item's decision, in plan order.

    Returns:
        The opaque fingerprint. Deterministic: the same plan always mints the same token, so a
        client may compare two plans by comparing their fingerprints.
    """
    raw = json.dumps([item.as_row() for item in items], separators=(",", ":")).encode("utf-8")
    packed = base64.urlsafe_b64encode(zlib.compress(raw, 9)).decode("ascii").rstrip("=")
    return f"{_PREFIX}{packed}"


def decode_plan_fingerprint(token: Optional[str]) -> Optional[List[ReviewedItem]]:
    """Read a fingerprint back into the decisions it holds.

    Every failure mode collapses to ``None`` — a token this server did not mint cannot be
    compared, and guessing at a malformed one would defeat the check it exists to perform.

    Args:
        token: The fingerprint a client echoed, or ``None``.

    Returns:
        The reviewed decisions, or ``None`` when the token is missing or unreadable.
    """
    if not isinstance(token, str) or not token.startswith(_PREFIX):
        return None
    payload = token[len(_PREFIX) :]
    try:
        padded = payload + "=" * (-len(payload) % 4)
        decompressor = zlib.decompressobj()
        raw = decompressor.decompress(base64.urlsafe_b64decode(padded), _MAX_DECODED_BYTES)
        if decompressor.unconsumed_tail:
            return None
        rows = json.loads(raw.decode("utf-8"))
    except (binascii.Error, ValueError, zlib.error, UnicodeDecodeError):
        return None
    if not isinstance(rows, list):
        return None

    items: List[ReviewedItem] = []
    for row in rows:
        if not isinstance(row, list) or len(row) != 4:
            return None
        if not all(isinstance(field, str) for field in row):
            return None
        items.append(
            ReviewedItem(
                key=row[0], resolution=row[1], project_id=row[2], version_id=row[3]
            )
        )
    return items


@dataclass(frozen=True)
class PlanDrift:
    """One way the re-planned batch disagrees with the plan that was reviewed.

    Attributes:
        key: The item that moved.
        change: Which part moved — ``resolution``, ``target``, ``version``, ``item-missing``
            or ``item-added``.
        reviewed: What the reviewer was shown, phrased by :func:`describe_reviewed_item`.
        current: What re-planning says now.
        detail: One sentence a user can act on.
    """

    key: str
    change: str
    reviewed: str
    current: str
    detail: str

    def as_dict(self) -> Dict[str, Any]:
        """This drift as the JSON row the refusal carries."""
        return {
            "key": self.key,
            "change": self.change,
            "reviewed": self.reviewed,
            "current": self.current,
            "detail": self.detail,
        }


def detect_plan_drift(
    reviewed: Sequence[ReviewedItem],
    current: Sequence[ReviewedItem],
    *,
    keys: Optional[Sequence[str]] = None,
) -> List[PlanDrift]:
    """Compare a reviewed plan against the one re-planning just produced.

    Args:
        reviewed: The decisions carried by the client's fingerprint.
        current: The decisions the submit's own re-plan produced, in plan order.
        keys: The item keys this batch will act on. ``None`` (or empty) means the batch acts
            on every planned item, so an item appearing or vanishing is itself drift; a
            non-empty selection narrows the comparison to it.

    Returns:
        One :class:`PlanDrift` per disagreeing item, in the current plan's order followed by
        the reviewed items that vanished. Empty when the plan still holds.
    """
    reviewed_by_key = {item.key: item for item in reviewed}
    current_by_key = {item.key: item for item in current}
    selected = [key for key in keys or () if key]

    if selected:
        compared = list(dict.fromkeys(selected))
    else:
        compared = [item.key for item in current]
        compared += [key for key in reviewed_by_key if key not in current_by_key]

    drifts: List[PlanDrift] = []
    for key in compared:
        before = reviewed_by_key.get(key)
        after = current_by_key.get(key)
        change = _change_between(before, after)
        if change is None:
            continue
        drifts.append(
            PlanDrift(
                key=key,
                change=change,
                reviewed=describe_reviewed_item(before),
                current=describe_reviewed_item(after),
                detail=_drift_detail(key, change, before, after),
            )
        )
    return drifts


def _change_between(
    before: Optional[ReviewedItem], after: Optional[ReviewedItem]
) -> Optional[str]:
    """Name the first field that moved between two decisions, or ``None`` when none did."""
    if before is None and after is None:
        # A key in neither plan is an unknown key, which the batch already reports per item.
        return None
    if after is None:
        return "item-missing"
    if before is None:
        return "item-added"
    if before.resolution != after.resolution:
        return "resolution"
    if before.project_id != after.project_id:
        return "target"
    if before.version_id != after.version_id:
        return "version"
    return None


def _drift_detail(
    key: str, change: str, before: Optional[ReviewedItem], after: Optional[ReviewedItem]
) -> str:
    """Write the sentence that tells a user what moved and what to do about it."""
    if change == "item-missing":
        return (
            f"{key!r} was in the plan you reviewed and is no longer in the payload's plan. "
            "Re-plan the batch and review it again."
        )
    if change == "item-added":
        return (
            f"{key!r} is in the payload's plan now and was not in the one you reviewed. "
            "Re-plan the batch, or name the items you meant in 'keys'."
        )
    nouns = {
        "resolution": "would do something different",
        "target": "would land in a different project",
        "version": "would create a different version",
    }
    return (
        f"{key!r} {nouns.get(change, 'changed')} now: you reviewed "
        f"{describe_reviewed_item(before)}, and it would now be "
        f"{describe_reviewed_item(after)}. Re-plan the batch, or send an override that says "
        "what you want."
    )
