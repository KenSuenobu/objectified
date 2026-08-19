'use client';

/**
 * Side-by-side server comparison panel (V2-MCP-32.2 / MCAT-18.2; redesigned HIVE-7.9, #5326).
 *
 * Authority: `docs/mockups/sources/mcp-compare.html`, whose **Notes → Keeps (1:1)** list is this
 * panel's acceptance criteria.
 *
 * The evaluator's decision screen: 2–3 servers aligned column-by-column. From the pure
 * {@link mcpCompareModel} it renders:
 *
 * - a **protocol cross-check** banner — amber when the servers negotiated different MCP protocol
 *   revisions, quiet when they agree but one never reported a version;
 * - one **column header** per server — its name, endpoint subtitle, transport / category chips and
 *   its {@link GradeGlyph};
 * - an **aligned metric table** — surface counts, quality, safety posture, documentation coverage,
 *   tool latency and composite trust, one section at a time, with every *differing* row tinted so
 *   a reader's eye lands on what actually separates the servers;
 * - a **trust radar** per column, toned by its overall band; and
 * - the **capability-overlap** view — a shared-tool presence matrix plus each server's unique
 *   tools.
 *
 * Every projection comes from the pure, unit-tested `mcpServerCompareUi`, so the table, the radars
 * and the overlap can never disagree. The component owns its loading / error / too-few-selected
 * states.
 *
 * ### "Only genuinely differing rows"
 *
 * The tint is not a per-cell comparison in this file — it is {@link McpCompareRow.differs}, which
 * `cellsDiffer` derives from the cells' *comparable* values and falls back to their display text
 * only where there is no number (a grade letter, an auth label). Two consequences the mockup draws
 * and this panel keeps: a row where every server reports `0` is **not** tinted, because zero is a
 * real agreement; and a row where every server reports `—` is not tinted either, because "none of
 * them measured this" is also an agreement. Only a row whose columns actually disagree is marked,
 * and the table's foot says so in words so the tint is never the only signal.
 *
 * ### What the redesign changed
 *
 * 1. **The tint was `bg-amber-50/60 dark:bg-amber-900/10`** — one light palette and one dark one,
 *    which meant seven of the nine themes drew a differing row in a colour nothing else on the
 *    page used. It is `.mcpx-differs`, a `color-mix()` of `--warn` into the surface, which every
 *    theme recalibrates.
 * 2. **The protocol banner was a hand-built box** with eight amber classes on one branch and six
 *    greys on the other. Both are `ui/Alert`, which is the banner every other warning in the
 *    product draws.
 * 3. **The table had no foot.** The two conventions it relies on — the tint and the em dash — were
 *    left to be inferred; they are stated now, as the mockup states them.
 * 4. **The check and the absence marker were `text-emerald-600` and `text-gray-300`.** They are
 *    `--ok` and `--fg-faint`, and both keep the `aria-label` that carries the fact in words: the
 *    mark is decoration over an announced value, not the value itself.
 * 5. **The unique-tool cards were `border-gray-100 bg-gray-50 dark:bg-gray-800/50`.** They are
 *    `Card variant="flat"` — a hairline on the surface, which is the design language's "panel
 *    inside a panel". Not `soft`, whose `--bg-subtle` ground measures 4.35:1 under the
 *    `--fg-muted` tool names in Solarized; `mcp-analytics-compare-css.test.ts` measures it.
 * 6. **Every string was inline.** They live in `mcpServerCompareUi` beside the model, so the page
 *    header's own copy and the panel's cannot drift.
 */

import * as React from 'react';
import { ArrowLeftRight, Check, GitCompareArrows, Layers, ServerOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { Alert } from '@/app/components/ui/Alert';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { ErrorState } from '@/app/components/ui/ErrorState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { McpBadge } from '@/app/components/ui/mcp/McpBadge';
import { GradeGlyph } from '@/app/components/ui/mcp/GradeGlyph';
import { Radar } from '@/app/components/ui/mcp/charts';
import { mcpTransportBadge } from '@/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import {
  mcpTrustRadarAxes,
  mcpTrustBand,
  mcpTrustFormatValue,
  MCP_TRUST_AXIS_MAX,
  MCP_TRUST_BAND_TONE,
} from '@/app/components/ade/dashboard/mcp/mcpTrustUi';
import {
  MCP_COMPARE_ERROR_TITLE,
  MCP_COMPARE_NO_SHARED,
  MCP_COMPARE_NO_UNIQUE,
  MCP_COMPARE_OVERLAP_TITLE,
  MCP_COMPARE_PROMPT_DESC,
  MCP_COMPARE_PROMPT_TITLE,
  MCP_COMPARE_PROTOCOL_DIFFER_TITLE,
  MCP_COMPARE_PROTOCOL_UNKNOWN,
  MCP_COMPARE_RUNNING,
  MCP_COMPARE_TABLE_FOOT,
  MCP_COMPARE_MIN_SELECTION,
  mcpCompareModel,
  mcpCompareOverlapSummary,
  type McpCompareServer,
  type McpCompareRow,
} from '@/app/components/ade/dashboard/mcp/mcpServerCompareUi';

interface Props {
  /** The compared servers (2–3), in column order, or `null` before a comparison is run. */
  servers: McpCompareServer[] | null;
  loading: boolean;
  error: string | null;
  /** Re-run the comparison. Wired to the error state's retry. */
  onRetry?: () => void;
}

/** One column-header cell: server identity, transport/category chips, and its grade glyph. */
function ColumnHeader({ server }: { server: McpCompareServer }) {
  const transport = mcpTransportBadge(server.transport);
  return (
    <th scope="col" className="mcpx-col">
      <div className="mcpx-col__id">
        <GradeGlyph grade={server.grade} score={server.score} size="sm" showScore={false} />
        <div className="min-w-0">
          <div className="mcpx-col__name" title={server.displayName}>
            {server.displayName}
          </div>
          {server.endpointName && server.endpointName !== server.displayName ? (
            <div className="mcpx-col__sub" title={server.endpointName}>
              {server.endpointName}
            </div>
          ) : null}
        </div>
      </div>
      <div className="mcpx-col__chips">
        <McpBadge tone={transport.tone}>{transport.label}</McpBadge>
        {server.category ? <McpBadge tone="indigo">{server.category}</McpBadge> : null}
      </div>
    </th>
  );
}

/** One aligned metric row: label + one cell per server; differing rows are tinted. */
function MetricRow({ row }: { row: McpCompareRow }) {
  return (
    <tr className={row.differs ? 'mcpx-differs' : undefined} data-differs={row.differs || undefined}>
      <th scope="row" className="mcpx-metric">
        {row.label}
      </th>
      {row.cells.map((cell, index) => (
        <td key={index} className="mcpx-value">
          {cell.display}
        </td>
      ))}
    </tr>
  );
}

/**
 * The server-comparison panel.
 *
 * Owns its loading / error / too-few-selected states; every populated region renders straight from
 * the pure model, so the aligned metrics, the radars and the overlap are one source of truth.
 *
 * @param props See {@link Props}.
 * @returns The comparison, or the one state that stands in for it.
 */
export function ServerComparisonPanel({ servers, loading, error, onRetry }: Props) {
  if (loading && (!servers || servers.length === 0)) {
    return <LoadingState minHeightClassName="min-h-[320px]" message={MCP_COMPARE_RUNNING} />;
  }
  if (error) {
    return (
      <ErrorState
        variant="compact"
        icon={<ServerOff aria-hidden />}
        title={MCP_COMPARE_ERROR_TITLE}
        description={error}
        onRetry={onRetry}
        data-testid="mcp-compare-error"
      />
    );
  }
  if (!servers) return null;

  if (servers.length < MCP_COMPARE_MIN_SELECTION) {
    return (
      <EmptyState
        variant="compact"
        tone="neutral"
        icon={<GitCompareArrows aria-hidden />}
        title={MCP_COMPARE_PROMPT_TITLE}
        description={MCP_COMPARE_PROMPT_DESC}
        data-testid="mcp-compare-prompt"
      />
    );
  }

  const { sections, overlap, protocol } = mcpCompareModel(servers);
  const colCount = servers.length;

  return (
    <div className="mcpx-panel" aria-busy={loading} data-testid="mcp-compare-panel">
      {/* Protocol cross-check. */}
      {!protocol.allMatch ? (
        <Alert variant="warn" data-testid="mcp-compare-protocol">
          <span>
            <strong>{MCP_COMPARE_PROTOCOL_DIFFER_TITLE}</strong> These servers negotiated different
            MCP protocol revisions ({protocol.distinct.join(', ')})
            {protocol.hasUnknown ? ', and at least one is unknown' : ''} — some capabilities and
            annotations may not be comparable like-for-like.
          </span>
        </Alert>
      ) : protocol.hasUnknown ? (
        <Alert variant="neutral" icon={<Layers aria-hidden />} data-testid="mcp-compare-protocol">
          <span>{MCP_COMPARE_PROTOCOL_UNKNOWN}</span>
        </Alert>
      ) : null}

      {/* Aligned metric table. */}
      <div className="mcpx-table-card">
        <div className="mcpx-scroll">
          <table className="mcpx-table table-density" data-testid="mcp-compare-table">
            <caption className="sr-only">
              Compared servers, metric by metric. Rows whose cells differ are marked.
            </caption>
            <thead>
              <tr>
                <th scope="col" className="mcpx-metric mcpx-metric--head">
                  Metric
                </th>
                {servers.map((server) => (
                  <ColumnHeader key={server.endpointId} server={server} />
                ))}
              </tr>
            </thead>
            <tbody>
              {sections.map((section) => (
                <React.Fragment key={section.key}>
                  <tr className="mcpx-section">
                    <th scope="colgroup" colSpan={colCount + 1}>
                      {section.title}
                    </th>
                  </tr>
                  {section.rows.map((row) => (
                    <MetricRow key={row.key} row={row} />
                  ))}
                  {section.key === 'trust' ? (
                    <tr>
                      <th scope="row" className="mcpx-metric">
                        Trust radar
                      </th>
                      {servers.map((server) => (
                        <td key={server.endpointId} className="mcpx-value">
                          {server.trust ? (
                            <Radar
                              axes={mcpTrustRadarAxes(server.trust)}
                              max={MCP_TRUST_AXIS_MAX}
                              tone={MCP_TRUST_BAND_TONE[mcpTrustBand(server.trust.overall)]}
                              title={`Trust radar — ${server.displayName}, overall ${mcpTrustFormatValue(server.trust.overall)} of 100`}
                              className="mcpx-radar"
                            />
                          ) : (
                            <span className="mcpx-gap">Not measured</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  ) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mcpx-table-foot">{MCP_COMPARE_TABLE_FOOT}</p>
      </div>

      {/* Capability overlap. */}
      <Card data-testid="mcp-compare-overlap">
        <CardHeader className="mcpx-card__head">
          <CardTitle className="mcpx-card__title">
            <ArrowLeftRight aria-hidden />
            {MCP_COMPARE_OVERLAP_TITLE}
          </CardTitle>
          <span className="mcpx-card__note">{mcpCompareOverlapSummary(overlap)}</span>
        </CardHeader>
        <CardContent className="mcpx-overlap">
          {/* Shared presence matrix. */}
          {overlap.shared.length === 0 ? (
            <p className="mcpx-note">{MCP_COMPARE_NO_SHARED}</p>
          ) : (
            <div className="mcpx-scroll">
              <table className="mcpx-matrix table-density">
                <caption className="sr-only">
                  Which of the compared servers expose each shared tool.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Shared tool</th>
                    {servers.map((server) => (
                      <th
                        key={server.endpointId}
                        scope="col"
                        className="mcpx-matrix__server"
                        title={server.displayName}
                      >
                        {server.displayName}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {overlap.shared.map((entry) => (
                    <tr key={entry.name}>
                      <td className="mono">{entry.name}</td>
                      {servers.map((server) => {
                        const present = entry.presentIn.includes(server.endpointId);
                        return (
                          <td key={server.endpointId} className="mcpx-matrix__cell">
                            {present ? (
                              <Check className="mcpx-present" aria-label="present" />
                            ) : (
                              <span className="mcpx-absent" aria-label="absent">
                                ·
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Per-server unique tools. */}
          <div className="mcpx-unique">
            {overlap.uniqueByServer.map((group) => (
              <Card key={group.endpointId} variant="flat" className="mcpx-unique__card">
                <div className="mcpx-unique__title" title={group.displayName}>
                  Unique to {group.displayName}
                </div>
                {group.tools.length === 0 ? (
                  <p className="mcpx-note">{MCP_COMPARE_NO_UNIQUE}</p>
                ) : (
                  <ul className="mcpx-unique__list">
                    {group.tools.map((tool) => (
                      <li key={tool} className="mono" title={tool}>
                        {tool}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
