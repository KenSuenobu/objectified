"""Batch apply: turn one reviewed plan row into the job it starts (BLK-1.3, #5525).

BLK-1.2 made the plan say what *would* happen to each item — append a version to a project
that already exists, or create one. This module is the other half: it turns that answer, plus
whatever the reviewer overrode, into the concrete
:class:`~app.models.SpecImportStartMetadata` shape one item's job is submitted with.

.. code-block:: text

    plan resolution ─┐
                     ├─► decide_item_target ─► action + project + version ─► one import job
    per-item override ┘

Why this is a module and not four lines in the route
----------------------------------------------------
The submit endpoint used to answer the question with a constant: every item was submitted as
``SpecImportProjectTarget(name=…, slug=…)`` at version ``1.0.0``, so a batch could only ever
mint new projects at their first version. Deriving the answer properly means three inputs
(the reconciliation, the override, the target project's existing labels) and one rule set,
and that rule set has to be *the same one* the verify pass reports — otherwise ``dry_run``
describes an import the apply would not perform. One function, called by both paths, is what
makes "verify and apply are the same computation" a fact rather than a claim.

The decision
------------
``mode`` is the reviewer's verb and it wins outright; an absent override means "apply the
BLK-1.2 resolution", so the common case stays a one-click apply:

===========================  ===========================================================
Input                        Outcome
===========================  ===========================================================
override ``mode: new``       :attr:`TargetAction.CREATE_PROJECT`, whatever the plan said
override ``mode: existing``  :attr:`TargetAction.APPEND_VERSION` onto ``project_id``,
                             else onto the matched project
override ``project_id``      Implies ``existing`` — naming a project *is* the decision
no override                  The plan's own resolution
``unresolved``, no override  Refused: ``always-ask`` means the batch must be told
===========================  ===========================================================

Versions are derived, never assumed. An append proposes against the **target project's own**
labels with :func:`app.bulk_import_reconciliation.propose_version` — the same function the
plan used — so an item applied straight from its plan gets exactly the label the plan
promised, and an item flipped onto a different project gets the label *that* project's
history implies rather than a stale one. ``version_id`` on the override is the escape hatch
for a real version number the batch cannot know. Only a create falls back to the batch
default, because a project that does not exist yet has no history to derive from.

Catalog items take an append by slug, not by id
-----------------------------------------------
BLK-1.1's ``project.project_id`` refuses a non-publishable catalog item outright
(``TARGET_NOT_PUBLISHABLE``) — an imported *API version* cannot land on a row that keeps its
source verbatim. But a re-imported protobuf tree or SQL schema matches exactly such a row, and
"append a version to it" is precisely what should happen: ``_resolve_import_project`` in
:mod:`app.import_source_pipeline` already adds another revision to a live catalog item with
the same slug. So an append onto a **matched** catalog item is submitted as the name/slug
shape carrying that item's own slug, which lands the revision on it. The revision goes to the
same place either way; only the field that names it differs.

An **explicitly overridden** ``project_id`` is not folded that way. There the reviewer named a
project rather than accepting a match, and BLK-1.1's refusal is the honest answer to naming a
catalog item — reported as that item's failed row, like every other per-item refusal.

Nothing here reads or writes the database directly. ``version_labels`` is injected so the
caller's cached :class:`~app.bulk_import_reconciliation.ProjectReconciler` serves the whole
batch, and so the decision is a pure function under test.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional, Sequence

from .bulk_import_reconciliation import ItemResolution, Resolution, propose_version

__all__ = [
    "TARGET_DECISION_REQUIRED",
    "ItemOverride",
    "ItemTarget",
    "ItemTargetError",
    "OverrideMode",
    "TargetAction",
    "decide_item_target",
    "parse_override_mode",
]

#: The batch was handed no decision for an item that has none of its own — an ``unresolved``
#: row under the ``always-ask`` policy, or an ``existing`` override naming no project.
TARGET_DECISION_REQUIRED = "TARGET_DECISION_REQUIRED"


class TargetAction(str, Enum):
    """What one item's job is started to do. The applied twin of :class:`Resolution`.

    Deliberately only two members: ``unresolved`` is a state a *plan* may be in, never a state
    an apply may be in. An item that reaches the submit endpoint still undecided is refused
    rather than guessed at.
    """

    #: Add a new version to a project that already exists.
    APPEND_VERSION = "append-version"
    #: Create a project (or, for a catalog format, a catalog item) from this document.
    CREATE_PROJECT = "create-project"


class OverrideMode(str, Enum):
    """The reviewer's verb for one item, overriding what the plan resolved."""

    #: Append to a project that already exists — ``project_id`` when given, else the match.
    EXISTING = "existing"
    #: Create a project, whatever the plan matched.
    NEW = "new"


def parse_override_mode(value: Optional[object]) -> Optional[OverrideMode]:
    """Parse an override mode token, tolerating the words a human would type.

    Args:
        value: The raw token (``existing`` / ``new``, or their natural synonyms), or ``None``.

    Returns:
        The :class:`OverrideMode`, or ``None`` when nothing was supplied.

    Raises:
        ValueError: When a non-empty token names no mode.
    """
    if isinstance(value, OverrideMode):
        return value
    if value is None:
        return None
    token = str(value).strip().lower()
    if not token:
        return None
    aliases = {
        "existing": OverrideMode.EXISTING,
        "append": OverrideMode.EXISTING,
        "append-version": OverrideMode.EXISTING,
        "new": OverrideMode.NEW,
        "create": OverrideMode.NEW,
        "create-project": OverrideMode.NEW,
    }
    try:
        return aliases[token]
    except KeyError as exc:
        raise ValueError(
            f"{value!r} is not a target mode; use 'existing' (append a version) or 'new' "
            "(create a project)."
        ) from exc


@dataclass(frozen=True)
class ItemOverride:
    """One reviewer decision, replacing the plan's answer for a single item.

    Every field is independent: a ``version_id`` on its own keeps the plan's resolution and
    only renames the revision, which is how a batch carries a real version number without
    disagreeing with the reconciliation.

    Attributes:
        mode: The reviewer's verb, or ``None`` to keep the plan's resolution.
        project_id: The project to append to. Implies :attr:`OverrideMode.EXISTING`.
        version_id: The version label to create, replacing the derived one.
    """

    mode: Optional[OverrideMode] = None
    project_id: Optional[str] = None
    version_id: Optional[str] = None

    def is_empty(self) -> bool:
        """Whether this override decides nothing (and so changes nothing).

        Blank strings count as absent, so an entry carrying only whitespace is not reported
        as a decision the reviewer made.
        """
        return not (
            self.mode
            or (self.project_id or "").strip()
            or (self.version_id or "").strip()
        )


class ItemTargetError(Exception):
    """One item's target cannot be decided, so that item alone fails.

    Raised rather than returned so the caller cannot forget to check it, and carrying a
    taxonomy code rather than only a message so the failed row reads like every other
    per-item refusal in the batch.

    Attributes:
        code: The :mod:`app.intake_error_taxonomy` code for this refusal.
        message: What is wrong with *this* item.
    """

    def __init__(self, *, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ItemTarget:
    """The concrete destination one item's import job is started with.

    ``project_id`` and ``project_slug`` answer different questions and both matter:
    ``project_id`` is the BLK-1.1 field the request carries (``None`` for every create and for
    a catalog append, which is expressed by slug), while ``lands_on`` names the project the
    revision ends up in whichever shape was used — the id a status roll-up should agree with.

    Attributes:
        action: Append to an existing project, or create one.
        project_id: Value for ``project.project_id``; ``None`` for the name/slug shape.
        name: Value for ``project.name``.
        slug: Value for ``project.slug``.
        version_id: Value for ``version.version_id``.
        lands_on: Id of the project this revision is expected to land in, or ``None`` when
            the project does not exist yet.
        detail: One sentence stating the decision, for a verify screen and the CLI table.
        overridden: Whether a reviewer's override, rather than the plan, decided it.
    """

    action: TargetAction
    project_id: Optional[str]
    name: str
    slug: str
    version_id: str
    lands_on: Optional[str]
    detail: str
    overridden: bool


def decide_item_target(
    resolved: ItemResolution,
    override: Optional[ItemOverride] = None,
    *,
    suggested_name: str,
    suggested_slug: str,
    default_version_id: str,
    version_labels: Callable[[str], Sequence[str]],
) -> ItemTarget:
    """Decide what one batch item's import job does, from its plan row and its override.

    The single decision point BLK-1.3 turns on: ``dry_run`` and the apply call it with the
    same arguments, so the verify pass reports the import the apply performs rather than a
    parallel guess at it.

    Args:
        resolved: The item's BLK-1.2 reconciliation — resolution, match, proposed version.
        override: The reviewer's decision for this item, or ``None`` to apply the plan's.
        suggested_name: The item's catalog name, used when a project is created.
        suggested_slug: Its slug, likewise.
        default_version_id: The batch's fallback first version, used only when a project is
            being created and so has no history to derive a label from.
        version_labels: Reads a project's live version labels. Injected so one cached
            reconciler serves the batch; called at most once per append.

    Returns:
        The :class:`ItemTarget` to submit.

    Raises:
        ItemTargetError: The item has no decision and none was supplied — an ``unresolved``
            row with no override, or an ``existing`` override that named no project and had
            no match to fall back on.
    """
    decision = override or ItemOverride()
    match = resolved.match

    action, target_id = _effective_action(resolved, decision)
    overridden = _decides_target(decision) or (
        decision.version_id is not None and decision.version_id.strip() != ""
    )

    if action is TargetAction.CREATE_PROJECT:
        version_id = _explicit_version(decision) or default_version_id
        return ItemTarget(
            action=action,
            project_id=None,
            name=suggested_name,
            slug=suggested_slug,
            version_id=version_id,
            lands_on=None,
            detail=(
                f"Creates project {suggested_slug!r} at version {version_id}."
                + (" Chosen over the plan's resolution." if _decides_target(decision) else "")
            ),
            overridden=overridden,
        )

    assert target_id  # _effective_action refuses an append with no target
    version_id = _explicit_version(decision) or propose_version(
        version_labels(target_id), default_version_id=default_version_id
    ).version_id

    # A matched catalog item takes the revision by slug; see the module docstring. An
    # overridden id is left as an id on purpose, so BLK-1.1 answers for the reviewer's choice.
    matched_catalog = (
        match is not None
        and not match.publishable
        and match.project_id == target_id
        and not _names_project(decision)
    )
    if matched_catalog and match is not None:
        return ItemTarget(
            action=action,
            project_id=None,
            name=match.name or suggested_name,
            slug=match.slug or suggested_slug,
            version_id=version_id,
            lands_on=target_id,
            detail=(
                f"Appends version {version_id} to the catalog item "
                f"{(match.slug or suggested_slug)!r}, which takes a new revision by slug "
                "rather than by project id."
            ),
            overridden=overridden,
        )

    where = match.name if match and match.project_id == target_id and match.name else target_id
    return ItemTarget(
        action=action,
        project_id=target_id,
        name=suggested_name,
        slug=suggested_slug,
        version_id=version_id,
        lands_on=target_id,
        detail=(
            f"Appends version {version_id} to {where}."
            + (" Chosen over the plan's resolution." if _decides_target(decision) else "")
        ),
        overridden=overridden,
    )


def _effective_action(
    resolved: ItemResolution, decision: ItemOverride
) -> tuple[TargetAction, Optional[str]]:
    """Resolve ``(action, target project id)`` from the plan row and the override.

    Args:
        resolved: The item's reconciliation.
        decision: The override (possibly empty).

    Returns:
        The action and, for an append, the project to append to.

    Raises:
        ItemTargetError: The item is undecided, or an append has no project to aim at.
    """
    match = resolved.match
    matched_id = match.project_id if match else None
    named = _named_project(decision)

    if decision.mode is OverrideMode.NEW:
        return TargetAction.CREATE_PROJECT, None

    if decision.mode is OverrideMode.EXISTING or named:
        target = named or matched_id
        if not target:
            raise ItemTargetError(
                code=TARGET_DECISION_REQUIRED,
                message=(
                    "This item was overridden to append to an existing project, but no "
                    "'project_id' was given and nothing matched. Name the project, or "
                    "override the item to 'new'."
                ),
            )
        return TargetAction.APPEND_VERSION, target

    if resolved.resolution is Resolution.APPEND_VERSION and matched_id:
        return TargetAction.APPEND_VERSION, matched_id
    if resolved.resolution is Resolution.CREATE_PROJECT:
        return TargetAction.CREATE_PROJECT, None

    raise ItemTargetError(
        code=TARGET_DECISION_REQUIRED,
        message=(
            "This item is unresolved — the tenant's 'always-ask' reconciliation policy "
            "defers every choice to apply time. Send an override for it naming 'existing' "
            "(with a 'project_id') or 'new'."
        ),
    )


def _named_project(decision: ItemOverride) -> Optional[str]:
    """The project id an override names, normalized; ``None`` when it names none."""
    target = (decision.project_id or "").strip()
    return target or None


def _names_project(decision: ItemOverride) -> bool:
    """Whether the override picked the project itself, rather than inheriting the match."""
    return _named_project(decision) is not None


def _decides_target(decision: ItemOverride) -> bool:
    """Whether the override changes *where* the revision goes (as opposed to its label)."""
    return decision.mode is not None or _names_project(decision)


def _explicit_version(decision: ItemOverride) -> Optional[str]:
    """The version label an override pins, normalized; ``None`` when it pins none."""
    version = (decision.version_id or "").strip()
    return version or None
