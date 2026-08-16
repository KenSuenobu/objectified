'use client';

/**
 * Side-by-side server comparison panel (V2-MCP-32.2 / MCAT-18.2).
 *
 * The evaluator's decision screen: 2–3 servers aligned column-by-column. From the pure
 * {@link mcpCompareModel} it renders:
 *
 * - a **protocol cross-check** banner — highlighted when the servers negotiated different MCP
 *   protocol versions (the "differing protocol versions handled" criterion);
 * - one **column header** per server — its name, endpoint subtitle, transport / category chips, and
 *   its {@link GradeGlyph};
 * - an **aligned metric table** — surface counts, quality, safety posture, documentation coverage,
 *   tool latency, and composite trust, one section at a time, with every *differing* row highlighted
 *   so a reader's eye lands on what actually separates the servers;
 * - a **trust radar** per column, toned by its overall band; and
 * - the **capability-overlap** view — a shared-tool presence matrix plus each server's unique tools.
 *
 * Every projection comes from the pure, unit-tested `mcpServerCompareUi`, so the table, the radars,
 * and the overlap can never disagree. The component owns its loading / error / too-few-selected
 * states, and every colour resolves from a token via the shared badge/glyph/chart kit — no colour
 * literal appears here.
 */

import * as React from 'react';
import { ArrowLeftRight, Check, GitCompareArrows, Layers, ServerOff } from 'lucide-react';
import { EmptyState } from '@/app/components/ui/EmptyState';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { McpBadge } from '@/app/components/ui/mcp/McpBadge';
import { GradeGlyph } from '@/app/components/ui/mcp/GradeGlyph';
import { Radar } from '@/app/components/ui/mcp/charts';
import {
  mcpTransportBadge,
} from '@/app/components/ade/dashboard/mcp/mcpUiPrimitives';
import {
  mcpTrustRadarAxes,
  mcpTrustBand,
  mcpTrustFormatValue,
  MCP_TRUST_AXIS_MAX,
  MCP_TRUST_BAND_TONE,
} from '@/app/components/ade/dashboard/mcp/mcpTrustUi';
import {
  mcpCompareModel,
  type McpCompareServer,
  type McpCompareRow,
} from '@/app/components/ade/dashboard/mcp/mcpServerCompareUi';

interface Props {
  /** The compared servers (2–3), in column order, or `null` before a comparison is run. */
  servers: McpCompareServer[] | null;
  loading: boolean;
  error: string | null;
}

/** The tint a differing metric row gets so real differences stand out from matching rows. */
const DIFF_ROW_CLASS = 'bg-amber-50/60 dark:bg-amber-900/10';

/** One column-header cell: server identity, transport/category chips, and its grade glyph. */
function ColumnHeader({ server }: { server: McpCompareServer }) {
  const transport = mcpTransportBadge(server.transport);
  return (
    <th scope="col" className="min-w-[9rem] px-3 py-3 text-left align-top">
      <div className="flex items-start gap-2">
        <GradeGlyph grade={server.grade} score={server.score} size="sm" showScore={false} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-gray-900 dark:text-white" title={server.displayName}>
            {server.displayName}
          </div>
          {server.endpointName && server.endpointName !== server.displayName ? (
            <div className="truncate text-xs text-gray-500 dark:text-gray-400" title={server.endpointName}>
              {server.endpointName}
            </div>
          ) : null}
          <div className="mt-1 flex flex-wrap gap-1">
            <McpBadge tone={transport.tone} className="px-1.5 py-0 text-2xs">
              {transport.label}
            </McpBadge>
            {server.category ? (
              <McpBadge tone="indigo" className="px-1.5 py-0 text-2xs">
                {server.category}
              </McpBadge>
            ) : null}
          </div>
        </div>
      </div>
    </th>
  );
}

/** One aligned metric row: label + one cell per server; differing rows are tinted. */
function MetricRow({ row }: { row: McpCompareRow }) {
  return (
    <tr className={row.differs ? DIFF_ROW_CLASS : undefined}>
      <th
        scope="row"
        className="whitespace-nowrap px-3 py-1.5 text-left text-xs font-medium text-gray-600 dark:text-gray-300"
      >
        {row.label}
      </th>
      {row.cells.map((cell, index) => (
        <td
          key={index}
          className="px-3 py-1.5 text-sm tabular-nums text-gray-900 dark:text-gray-100"
        >
          {cell.display}
        </td>
      ))}
    </tr>
  );
}

/**
 * The server-comparison panel. Owns its loading / error / too-few-selected states; every populated
 * region renders straight from the pure model, so the aligned metrics, the radars, and the overlap
 * are one source of truth.
 */
export function ServerComparisonPanel({ servers, loading, error }: Props) {
  if (loading && (!servers || servers.length === 0)) {
    return <LoadingState minHeightClassName="min-h-[320px]" message="Comparing servers…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<ServerOff className="h-8 w-8 text-white" aria-hidden />}
        title="Comparison unavailable"
        description={error}
      />
    );
  }
  if (!servers) return null;

  if (servers.length < 2) {
    return (
      <EmptyState
        variant="compact"
        icon={<GitCompareArrows className="h-8 w-8 text-white" aria-hidden />}
        title="Select two or three servers to compare"
        description="Pick 2–3 discovered MCP servers from the catalog above, then compare their surface, grade, safety posture, documentation coverage, tool latency, and composite trust side by side — with the tools they share and the tools unique to each highlighted."
      />
    );
  }

  const model = mcpCompareModel(servers);
  const { sections, overlap, protocol } = model;
  const colCount = servers.length;

  return (
    <div className="space-y-5" aria-busy={loading}>
      {/* Protocol cross-check. */}
      {!protocol.allMatch ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          <Layers className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-semibold">Protocol versions differ.</span> These servers negotiated
            different MCP protocol revisions ({protocol.distinct.join(', ')})
            {protocol.hasUnknown ? ', and at least one is unknown' : ''} — some capabilities and
            annotations may not be comparable like-for-like.
          </span>
        </div>
      ) : protocol.hasUnknown ? (
        <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
          <Layers className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>At least one server&apos;s MCP protocol version is unknown.</span>
        </div>
      ) : null}

      {/* Aligned metric table. */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-700">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50 dark:border-gray-700 dark:bg-gray-800/60">
              <th scope="col" className="px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                Metric
              </th>
              {servers.map((server) => (
                <ColumnHeader key={server.endpointId} server={server} />
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {sections.map((section) => (
              <React.Fragment key={section.key}>
                <tr className="bg-gray-50/70 dark:bg-gray-800/40">
                  <th
                    scope="colgroup"
                    colSpan={colCount + 1}
                    className="px-3 py-1.5 text-left text-2xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400"
                  >
                    {section.title}
                  </th>
                </tr>
                {section.rows.map((row) => (
                  <MetricRow key={row.key} row={row} />
                ))}
                {section.key === 'trust' ? (
                  <tr>
                    <th scope="row" className="px-3 py-2 align-top text-xs font-medium text-gray-600 dark:text-gray-300">
                      Trust radar
                    </th>
                    {servers.map((server) => (
                      <td key={server.endpointId} className="px-3 py-2">
                        {server.trust ? (
                          <Radar
                            axes={mcpTrustRadarAxes(server.trust)}
                            max={MCP_TRUST_AXIS_MAX}
                            tone={MCP_TRUST_BAND_TONE[mcpTrustBand(server.trust.overall)]}
                            title={`Trust radar — ${server.displayName}, overall ${mcpTrustFormatValue(server.trust.overall)} of 100`}
                            className="h-28 w-28"
                          />
                        ) : (
                          <span className="text-xs text-gray-400 dark:text-gray-500">Not measured</span>
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

      {/* Capability overlap. */}
      <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
        <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-gray-100">
          <ArrowLeftRight className="h-4 w-4 text-gray-400 dark:text-gray-500" aria-hidden />
          Capability overlap
        </h3>
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          {overlap.totalDistinct} distinct tool{overlap.totalDistinct === 1 ? '' : 's'} across these
          servers — {overlap.sharedByAllCount} shared by all, {overlap.shared.length} shared by two or
          more.
        </p>

        {/* Shared presence matrix. */}
        {overlap.shared.length === 0 ? (
          <p className="text-xs text-gray-500 dark:text-gray-400">No tools are shared between these servers.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700">
                  <th scope="col" className="px-2 py-1.5 text-xs font-semibold text-gray-500 dark:text-gray-400">
                    Shared tool
                  </th>
                  {servers.map((server) => (
                    <th
                      key={server.endpointId}
                      scope="col"
                      className="px-2 py-1.5 text-center text-xs font-semibold text-gray-500 dark:text-gray-400"
                      title={server.displayName}
                    >
                      <span className="block max-w-[7rem] truncate">{server.displayName}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {overlap.shared.map((entry) => (
                  <tr key={entry.name}>
                    <td className="px-2 py-1.5 font-mono text-xs text-gray-800 dark:text-gray-100">
                      {entry.name}
                    </td>
                    {servers.map((server) => {
                      const present = entry.presentIn.includes(server.endpointId);
                      return (
                        <td key={server.endpointId} className="px-2 py-1.5 text-center">
                          {present ? (
                            <Check className="mx-auto h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-label="present" />
                          ) : (
                            <span className="text-gray-300 dark:text-gray-600" aria-label="absent">
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
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {overlap.uniqueByServer.map((group) => (
            <div key={group.endpointId} className="rounded-lg border border-gray-100 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-800/50">
              <div className="mb-1.5 truncate text-xs font-semibold text-gray-700 dark:text-gray-200" title={group.displayName}>
                Unique to {group.displayName}
              </div>
              {group.tools.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">No unique tools.</p>
              ) : (
                <ul className="space-y-0.5">
                  {group.tools.map((tool) => (
                    <li key={tool} className="truncate font-mono text-xs text-gray-700 dark:text-gray-200" title={tool}>
                      {tool}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
