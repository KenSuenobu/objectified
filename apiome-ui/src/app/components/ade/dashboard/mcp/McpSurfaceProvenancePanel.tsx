'use client';

/**
 * Where each surface fact came from — FMT-1.7 (#5418).
 *
 * An MCP endpoint can now be catalogued two ways: probed, or described by an imported manifest.
 * That turns every fact on its surface into two possible claims — something Apiome *watched the
 * server say*, or something an operator *told Apiome* — and a detail view that renders both the
 * same way has quietly turned a description into an observation.
 *
 * This panel keeps them apart. It leads with the relationship between the two surfaces (do their
 * fingerprints agree?), then attributes each fact: `Observed`, `Declared`, or `Both`. Where both
 * carry a fact with different values it opens the pair side by side and marks it a conflict — it
 * never picks a winner, because nothing here knows which is right.
 *
 * It draws nothing at all when the endpoint has neither source, which is the common case: an
 * endpoint that has only ever been probed and never had a manifest imported reads as
 * `observed_only`, and a one-line note is enough. The panel earns its space when there is
 * genuinely a second source to distinguish from the first.
 *
 * ### Colour
 *
 * Every tone comes from `Badge`'s vocabulary and `Card`'s variants, so each ink is drawn on its
 * own matching ground. A `-fg` ink on a plain surface is legible in `:root` and `[data-theme=dark]`
 * and nowhere else — the failure HIVE-7.7 found across the MCP pills — so this panel has no colour
 * literals and never pairs a tone's ink with anything but that tone's `-soft` fill.
 */

import * as React from 'react';
import { AlertTriangle, Fingerprint, Loader2, Radar, ScrollText } from 'lucide-react';

import { Badge, type BadgeTone } from '@/app/components/ui/Badge';
import { Card, CardBody, CardHeader, CardTitle } from '@/app/components/ui/Card';
import {
  MCP_AGREEMENT_TONE,
  MCP_ORIGIN_LABEL,
  MCP_ORIGIN_MEANING,
  MCP_ORIGIN_TONE,
  MCP_SURFACE_MATCH_SUMMARY,
  MCP_SURFACE_MATCH_TITLE,
  MCP_SURFACE_MATCH_TONE,
  formatFactValue,
  groupSurfaceFacts,
  mcpSurfaceProvenanceFromPayload,
  shortFingerprint,
  type McpFactOrigin,
  type McpSurfaceFact,
  type McpSurfaceProvenance,
} from './mcpSurfaceProvenanceUi';

export interface McpSurfaceProvenancePanelProps {
  /** The endpoint whose surface is being attributed. */
  endpointId: string;
}

/** The panel's heading — pinned by the test suite so the copy has one home. */
export const MCP_PROVENANCE_TITLE = 'Where these facts came from';

/** What an endpoint with only observed facts says, in place of the whole panel. */
export const MCP_PROVENANCE_OBSERVED_ONLY_NOTE =
  'Every capability below was observed during discovery. Import a server manifest to record what the operator declares and compare the two.';

/** The origins the legend explains, in the order it lists them. */
const LEGEND_ORIGINS: readonly McpFactOrigin[] = ['observed', 'declared', 'both'];

function provenanceUrl(endpointId: string): string {
  return `/api/mcp/endpoints/${encodeURIComponent(endpointId)}/surface-provenance`;
}

async function fetchProvenance(endpointId: string): Promise<McpSurfaceProvenance> {
  const res = await fetch(provenanceUrl(endpointId), {
    credentials: 'include',
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : res.statusText);
  }
  return mcpSurfaceProvenanceFromPayload(data);
}

/**
 * One fact's row: its label, the source(s) that carry it, and — only when they disagree — the
 * two values side by side.
 *
 * @param props.fact The attributed fact.
 * @returns The row.
 */
function FactRow({ fact }: { fact: McpSurfaceFact }): React.JSX.Element {
  const conflicting = fact.agreement === 'conflicts';
  return (
    <li
      className="flex flex-col gap-1.5 py-2"
      data-testid="mcp-provenance-fact"
      data-origin={fact.origin}
      data-agreement={fact.agreement}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-sm text-fg">{fact.label}</span>
        <Badge
          variant={MCP_ORIGIN_TONE[fact.origin] as BadgeTone}
          title={MCP_ORIGIN_MEANING[fact.origin]}
        >
          {MCP_ORIGIN_LABEL[fact.origin]}
        </Badge>
        {conflicting ? (
          <Badge variant={MCP_AGREEMENT_TONE[fact.agreement] as BadgeTone}>
            <AlertTriangle aria-hidden />
            Conflict
          </Badge>
        ) : null}
      </div>
      {conflicting ? (
        <div className="grid gap-2 sm:grid-cols-2">
          <ValueBlock label="Declared" value={fact.declared} />
          <ValueBlock label="Observed" value={fact.observed} />
        </div>
      ) : null}
    </li>
  );
}

/**
 * One side of a conflict.
 *
 * @param props.label Which source this value came from.
 * @param props.value That source's value.
 * @returns The block.
 */
function ValueBlock({ label, value }: { label: string; value: unknown }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <p className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">{label}</p>
      <pre className="mono mt-1 max-h-40 overflow-auto rounded-xs bg-subtle p-2 text-2xs text-fg">
        {formatFactValue(value)}
      </pre>
    </div>
  );
}

/**
 * The declared-vs-observed attribution for one endpoint's surface.
 *
 * @param props See {@link McpSurfaceProvenancePanelProps}.
 * @returns The panel, or `null` while there is nothing to attribute.
 */
export function McpSurfaceProvenancePanel({
  endpointId,
}: McpSurfaceProvenancePanelProps): React.JSX.Element | null {
  const [report, setReport] = React.useState<McpSurfaceProvenance | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchProvenance(endpointId)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Unavailable');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpointId]);

  if (loading) {
    return (
      <Card variant="flat" data-testid="mcp-provenance-loading">
        <CardBody className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 className="animate-spin" aria-hidden />
          Attributing surface facts…
        </CardBody>
      </Card>
    );
  }

  // A failure here must not take the capabilities list down with it: the attribution is
  // commentary on facts the page already has, so it degrades to silence.
  if (error || !report || report.surfaceMatch === 'none') return null;

  if (report.surfaceMatch === 'observed_only') {
    return (
      <Card variant="flat" data-testid="mcp-provenance-observed-only">
        <CardBody className="flex items-start gap-2 text-sm text-fg-muted">
          <Radar aria-hidden className="mt-0.5 size-[var(--fs-md)] shrink-0" />
          <span>{MCP_PROVENANCE_OBSERVED_ONLY_NOTE}</span>
        </CardBody>
      </Card>
    );
  }

  const groups = groupSurfaceFacts(report.facts);
  return (
    <Card data-testid="mcp-provenance-panel" data-surface-match={report.surfaceMatch}>
      <CardHeader className="flex-row items-center gap-2">
        <ScrollText aria-hidden className="size-[var(--fs-md)] shrink-0 text-fg-muted" />
        <CardTitle>{MCP_PROVENANCE_TITLE}</CardTitle>
        <Badge
          className="ml-auto"
          variant={MCP_SURFACE_MATCH_TONE[report.surfaceMatch] as BadgeTone}
          data-testid="mcp-provenance-match"
        >
          {MCP_SURFACE_MATCH_TITLE[report.surfaceMatch]}
        </Badge>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">
          {MCP_SURFACE_MATCH_SUMMARY[report.surfaceMatch]}
        </p>

        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
          <div className="flex items-center gap-1.5">
            <Fingerprint aria-hidden className="size-[var(--fs-sm)] shrink-0 text-fg-muted" />
            <dt className="text-fg-muted">Declared</dt>
            <dd className="mono text-fg" data-testid="mcp-provenance-declared-fingerprint">
              {shortFingerprint(report.declaredFingerprint)}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <Fingerprint aria-hidden className="size-[var(--fs-sm)] shrink-0 text-fg-muted" />
            <dt className="text-fg-muted">Observed</dt>
            <dd className="mono text-fg" data-testid="mcp-provenance-observed-fingerprint">
              {shortFingerprint(report.observedFingerprint)}
            </dd>
          </div>
          {report.conflictCount > 0 ? (
            <div className="flex items-center gap-1.5">
              <dt className="sr-only">Conflicts</dt>
              <dd>
                <Badge variant="warn" data-testid="mcp-provenance-conflict-count">
                  <AlertTriangle aria-hidden />
                  {report.conflictCount} conflicting {report.conflictCount === 1 ? 'fact' : 'facts'}
                </Badge>
              </dd>
            </div>
          ) : null}
        </dl>

        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-fg-muted">
          {LEGEND_ORIGINS.map((origin) => (
            <li key={origin} className="flex items-center gap-1.5">
              <Badge variant={MCP_ORIGIN_TONE[origin] as BadgeTone}>
                {MCP_ORIGIN_LABEL[origin]}
              </Badge>
              <span>{MCP_ORIGIN_MEANING[origin]}</span>
            </li>
          ))}
        </ul>

        {groups.map((group) => (
          <section key={group.scope} data-testid={`mcp-provenance-group-${group.scope}`}>
            <h3 className="text-2xs font-semibold uppercase tracking-wide text-fg-muted">
              {group.kindLabel}
            </h3>
            <ul className="mt-1 divide-y divide-border">
              {group.facts.map((fact) => (
                <FactRow key={`${fact.scope}:${fact.key}`} fact={fact} />
              ))}
            </ul>
          </section>
        ))}
      </CardBody>
    </Card>
  );
}

export default McpSurfaceProvenancePanel;
