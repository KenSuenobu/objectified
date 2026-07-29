"""Privacy-safe catalog analysis telemetry — CPDO-4.2 (#4805).

Counters and structured log lines for the catalog payload-analysis surface: the
import-time analyzers (CPDO-1.2), the analysis / raw-source reads (CPDO-1.1),
the conversion projection and evidence pages (CPDO-1.3 / CPDO-3.3), and the UI
latency reports posted through ``POST /v1/catalog/{tenant}/analysis-metrics``.

Telemetry carries **counts, durations, and whitelisted categories only** —
never a payload value, a node name/label, a source location, an item name, or
any other fragment of the analysed source. Sizes are plain integers (node
counts, byte counts, page totals), which say how *big* a payload was without
saying anything about what was in it.

Kinds tracked:

* ``analysis_completed`` — an import-time analysis produced a record
  (status, latency, node count, payload bytes)
* ``analysis_failure`` — an analyzer did not complete (reason category)
* ``analysis_read`` — the full analysis tree was served (node count, latency)
* ``source_access`` — the raw captured source was served (access mode)
* ``projection_page`` — a bounded projection page was served
  (page total, latency, conversion status distribution)
* ``evidence_page`` — a stored evidence-snapshot page was served
* ``ui_latency`` — a UI surface reported its render/fetch latency
"""

from __future__ import annotations

import threading
from collections import defaultdict
from typing import Any, Dict, Mapping, Optional

from .logging_config import get_logger

_log = get_logger("app.analysis_telemetry")

#: Whitelist of metric kinds the REST surface (and UI proxy) may record.
ALLOWED_METRIC_KINDS = frozenset(
    {
        "analysis_completed",
        "analysis_failure",
        "analysis_read",
        "source_access",
        "projection_page",
        "evidence_page",
        "ui_latency",
    }
)

#: Controlled failure categories — the payload-analysis reason codes plus a
#: catch-all. Free-form caller text is never counted or logged.
ALLOWED_REASON_CATEGORIES = frozenset(
    {
        "not_analyzed",
        "no_source_captured",
        "unsupported_format",
        "bounds_exceeded",
        "analyzer_failed",
        "unknown",
    }
)

#: Controlled analysis statuses (mirrors ``app.payload_analysis.ANALYSIS_STATUSES``).
ALLOWED_STATUSES = frozenset({"available", "partial", "unavailable", "failed"})

#: UI surfaces that may report latency. A surface names a screen region, never content.
ALLOWED_UI_SURFACES = frozenset(
    {
        "format_tab",
        "x12_inspector",
        "copybook_inspector",
        "projection_graph",
        "evidence_drawer",
        "conversion_history",
        "source_viewer",
    }
)

#: How a raw-source read was answered: streamed inline content or a redirect
#: to the original URL.
ALLOWED_ACCESS_MODES = frozenset({"inline", "redirect"})

#: A projection/evidence page total above this is flagged ``large_tree`` so a
#: dashboard can watch how often oversized graphs are being paged.
LARGE_GRAPH_EDGE_THRESHOLD = 1000


class AnalysisTelemetry:
    """Thread-safe in-process counters + structured log emitter."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts: Dict[str, int] = defaultdict(int)

    def reset(self) -> None:
        """Clear all counters (unit tests)."""
        with self._lock:
            self._counts.clear()

    def snapshot(self) -> Dict[str, int]:
        """Return a copy of every counter key → count."""
        with self._lock:
            return dict(self._counts)

    def record(
        self,
        kind: str,
        *,
        reason_category: Optional[str] = None,
        status: Optional[str] = None,
        surface: Optional[str] = None,
        access_mode: Optional[str] = None,
        latency_ms: Optional[float] = None,
        node_count: Optional[int] = None,
        payload_bytes: Optional[int] = None,
        page_total: Optional[int] = None,
        status_counts: Optional[Mapping[str, int]] = None,
        large_tree: Optional[bool] = None,
        n: int = 1,
    ) -> None:
        """Increment counters and emit one privacy-safe structlog event.

        Args:
            kind: A member of :data:`ALLOWED_METRIC_KINDS`.
            reason_category: Optional member of :data:`ALLOWED_REASON_CATEGORIES`
                (silently dropped when not allowed — never logged as free text).
            status: Optional member of :data:`ALLOWED_STATUSES` (same treatment).
            surface: Optional member of :data:`ALLOWED_UI_SURFACES` (same treatment).
            access_mode: Optional member of :data:`ALLOWED_ACCESS_MODES` (same treatment).
            latency_ms: Wall-clock latency for the operation, when timed.
            node_count: Bounded analysis-tree node count (integer only).
            payload_bytes: Size of the analysed source in bytes (integer only).
            page_total: Bounded page/edge total (integer only).
            status_counts: Conversion status → edge count mapping (ints only) —
                the conversion status distribution a dashboard charts.
            large_tree: True when the served graph/tree exceeded
                :data:`LARGE_GRAPH_EDGE_THRESHOLD`.
            n: How many times to increment the kind counter.

        Raises:
            ValueError: When ``kind`` is not in the whitelist.
        """
        if kind not in ALLOWED_METRIC_KINDS:
            raise ValueError(f"unsupported analysis metric kind: {kind!r}")
        if n < 1:
            return

        safe_reason = reason_category if reason_category in ALLOWED_REASON_CATEGORIES else None
        safe_status = status if status in ALLOWED_STATUSES else None
        safe_surface = surface if surface in ALLOWED_UI_SURFACES else None
        safe_mode = access_mode if access_mode in ALLOWED_ACCESS_MODES else None
        safe_counts = _int_count_map(status_counts)

        with self._lock:
            self._counts[kind] += n
            if safe_reason is not None:
                self._counts[f"{kind}:{safe_reason}"] += n
            if safe_status is not None:
                self._counts[f"{kind}:{safe_status}"] += n
            if safe_surface is not None:
                self._counts[f"{kind}:{safe_surface}"] += n
            if safe_mode is not None:
                self._counts[f"{kind}:{safe_mode}"] += n

        payload: Dict[str, Any] = {
            "kind": kind,
            "n": n,
        }
        if safe_reason is not None:
            payload["reason_category"] = safe_reason
        if safe_status is not None:
            payload["status"] = safe_status
        if safe_surface is not None:
            payload["surface"] = safe_surface
        if safe_mode is not None:
            payload["access_mode"] = safe_mode
        if latency_ms is not None:
            payload["latency_ms"] = round(float(latency_ms), 3)
        if node_count is not None:
            payload["node_count"] = int(node_count)
        if payload_bytes is not None:
            payload["payload_bytes"] = int(payload_bytes)
        if page_total is not None:
            payload["page_total"] = int(page_total)
        if safe_counts:
            payload["status_counts"] = safe_counts
        if large_tree is not None:
            payload["large_tree"] = bool(large_tree)

        # Structured event name is the positional message; fields ride as kwargs.
        _log.info("catalog.analysis", **payload)


def _int_count_map(raw: Optional[Mapping[str, int]]) -> Dict[str, int]:
    """Copy a mapping keeping only string keys → non-negative int values."""
    if not raw:
        return {}
    out: Dict[str, int] = {}
    for key, value in raw.items():
        if not isinstance(key, str):
            continue
        try:
            count = int(value)
        except (TypeError, ValueError):
            continue
        if count >= 0:
            out[key] = count
    return out


#: Process-wide telemetry registry for the catalog analysis surface.
analysis_telemetry = AnalysisTelemetry()
