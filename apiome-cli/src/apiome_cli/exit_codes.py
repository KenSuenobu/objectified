"""CLI exit codes per clig.dev (success, error, usage) plus the quality-gate codes.

The first three codes are the CLI-wide contract every command honours. The gate codes
(3–5) are used **only** by the pre-flight surface (IXH-2.6): ``import preflight`` /
``export preflight`` and the ``--min-grade`` / ``--fail-on`` flags on the import and
export commands. They exist so a CI job can tell "the spec is not good enough" apart
from "the network was down" (:data:`EXIT_ERROR`) or "the credentials were wrong"
(:data:`EXIT_USAGE`, which every 4xx — including 401/403 — maps to), which is the whole
point of gating in a pipeline.

Failed import/export **jobs** reuse codes 1–3 via :mod:`apiome_cli.taxonomy_exit`
(IXH-6.4): taxonomy ``policy`` → 3, caller-fault categories → 2, transport/internal → 1.
"""

#: The command did what was asked.
EXIT_SUCCESS = 0

#: Transport failure, server error (5xx), or an unexpected client-side failure.
EXIT_ERROR = 1

#: Bad invocation, or a rejected request (any 4xx — including authentication).
EXIT_USAGE = 2

#: The tenant's import/export quality policy (IXH-2.3) **blocks** this payload. The
#: report was produced successfully; the answer is "policy refuses this". A waiver that
#: covers the shortfall downgrades the verdict server-side, so a waived payload does not
#: exit with this code — it is reported as waived and passes.
EXIT_POLICY_BLOCKED = 3

#: A ``--min-grade`` or ``--fail-on`` threshold supplied on the command line was not met.
#: Distinct from :data:`EXIT_POLICY_BLOCKED`: the tenant policy allowed the payload and
#: the caller's own, stricter CI threshold rejected it.
EXIT_QUALITY_GATE = 4

#: The pre-flight completed but its subject is unusable: an import candidate that cannot
#: be parsed at all (``ok: false``), or an export whose every ranked target is blocked or
#: unavailable. Nothing the caller can grade — there is no artifact to gate.
EXIT_PREFLIGHT_UNUSABLE = 5
