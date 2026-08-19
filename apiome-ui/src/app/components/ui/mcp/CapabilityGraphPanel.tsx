'use client';

/**
 * Capability relationship graph panel (V2-MCP-29.2 / MCAT-15.2).
 *
 * Renders a server snapshot's node-link graph — tools / resources / resource templates / prompts and
 * the concrete edges the backend inferred between them — as a static Mermaid `flowchart`. Node colors
 * follow the per-kind palette and re-theme live with the app's light/dark switch. A legend names the
 * kinds present, and isolated (unconnected) capabilities are called out explicitly per the ticket.
 *
 * All edge inference and diagram-source construction live in the pure, unit-tested
 * `mcpCapabilityGraphUi` module; this component only renders the produced SVG and its surrounding
 * chrome (legend, counts, isolated-node note, loading / empty / error states).
 */

import * as React from 'react';
import { Share2, AlertCircle } from 'lucide-react';
import { LoadingState } from '@/app/components/ui/LoadingState';
import { EmptyState } from '@/app/components/ui/EmptyState';
import {
  GRAPH_KIND_STYLES,
  mcpGraphLegend,
  mcpGraphToMermaid,
  type McpCapabilityGraph,
} from '@/app/components/ade/dashboard/mcp/mcpCapabilityGraphUi';

interface Props {
  /** The parsed graph for the selected snapshot, or `null` while it has not loaded. */
  graph: McpCapabilityGraph | null;
  loading: boolean;
  error: string | null;
}

/** A stable, module-level counter so each render gets a unique Mermaid element id (no `Date.now`). */
let mermaidSeq = 0;

/** The legend swatch + label row for the kinds present in the graph. */
function GraphLegend({ graph }: { graph: McpCapabilityGraph }) {
  const entries = mcpGraphLegend(graph);
  if (entries.length === 0) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-label="Node types">
      {entries.map((entry) => {
        const style = GRAPH_KIND_STYLES[entry.kind];
        return (
          <li key={entry.kind} className="flex items-center gap-1.5 text-xs text-fg-muted">
            <span
              className="inline-block h-3 w-3 rounded-sm border"
              // Legend swatches use the same per-kind palette the Mermaid nodes do (see module note).
              style={{ backgroundColor: style.fillLight, borderColor: style.strokeLight }}
              aria-hidden
            />
            <span className="font-medium text-fg">{entry.label}</span>
            <span className="tabular-nums text-fg-subtle">{entry.count}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The capability relationship graph panel. Handles its own loading / error / empty states so a slow or
 * missing graph never blanks the Insight tab.
 */
export function CapabilityGraphPanel({ graph, loading, error }: Props) {
  const [isDark, setIsDark] = React.useState(false);
  const [svg, setSvg] = React.useState<string>('');
  const [renderError, setRenderError] = React.useState<string | null>(null);
  // Scratch element handed to `mermaid.render` below. Without it, Mermaid appends its full-size
  // measurement div to <body> — outside the dashboard's overflow-hidden shell — and any leaked
  // scratch div makes the whole document scroll. Zero-height + overflow-hidden keeps it invisible
  // while still rendered (Mermaid needs a live element for text measurement).
  const scratchRef = React.useRef<HTMLDivElement | null>(null);

  // Follow the app theme switch (the `.dark` class on <html>) so the diagram re-themes live.
  React.useEffect(() => {
    const sync = () => setIsDark(document.documentElement.classList.contains('dark'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // Build the Mermaid source (pure) and render it to an SVG string whenever the graph or theme changes.
  React.useEffect(() => {
    let active = true;
    if (!graph) {
      setSvg('');
      setRenderError(null);
      return undefined;
    }
    const source = mcpGraphToMermaid(graph, isDark);
    if (!source) {
      setSvg('');
      setRenderError(null);
      return undefined;
    }
    (async () => {
      try {
        // Mermaid is a heavy, browser-only ESM dependency — import it lazily (client-side only) so it
        // never enters the module graph at import time (keeps SSR and unit tests free of it).
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'strict',
          fontFamily: 'var(--font-inter), -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        });
        mermaidSeq += 1;
        const { svg: rendered } = await mermaid.render(
          `mcp-cap-graph-${mermaidSeq}`,
          source,
          scratchRef.current ?? undefined,
        );
        if (!active) return;
        setSvg(rendered);
        setRenderError(null);
      } catch (e) {
        if (!active) return;
        setSvg('');
        setRenderError(e instanceof Error ? e.message : 'Could not render the graph.');
      }
    })();
    return () => {
      active = false;
    };
  }, [graph, isDark]);

  if (loading && !graph) {
    return <LoadingState minHeightClassName="min-h-[160px]" message="Loading graph…" />;
  }
  if (error) {
    return (
      <EmptyState
        variant="compact"
        icon={<Share2 className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="Graph unavailable"
        description={error}
      />
    );
  }
  if (!graph) return null;

  if (graph.nodes.length === 0) {
    return (
      <EmptyState
        variant="compact"
        icon={<Share2 className="h-8 w-8 text-fg-on-accent" aria-hidden />}
        title="No capabilities to map"
        description="This snapshot declares no tools, resources, or prompts, so there is nothing to relate."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <GraphLegend graph={graph} />
        <p className="text-xs text-fg-muted tabular-nums">
          {graph.node_count} {graph.node_count === 1 ? 'node' : 'nodes'} · {graph.edge_count}{' '}
          {graph.edge_count === 1 ? 'edge' : 'edges'}
        </p>
      </div>

      {renderError ? (
        <div className="flex items-center gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-fg">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
          <span>{renderError}</span>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-inset p-4 shadow-[inset_0_0_0_1px_var(--border)]">
          {/* Mermaid emits a self-contained SVG; render it inline. Source is sanitized + securityLevel:strict. */}
          <div
            className="flex min-w-fit justify-center [&_svg]:h-auto [&_svg]:max-w-none"
            role="img"
            aria-label={`Capability relationship graph: ${graph.node_count} nodes and ${graph.edge_count} inferred relationships`}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}

      {graph.edge_count === 0 ? (
        <p className="text-xs text-fg-muted">
          No relationships were inferred — every capability stands on its own. Edges appear only when a
          concrete signal (a prompt naming a tool, a tool referencing a resource URI, or a shared schema
          type) is present.
        </p>
      ) : graph.isolated_count > 0 ? (
        <p className="text-xs text-fg-muted tabular-nums">
          {graph.isolated_count}{' '}
          {graph.isolated_count === 1 ? 'capability is isolated' : 'capabilities are isolated'} — shown
          with no edges because no concrete relationship signal was found.
        </p>
      ) : null}

      {/* Mermaid's measurement scratch space — see scratchRef. Out of flow and clipped to nothing,
          but still rendered (display:none would break Mermaid's getBBox text measurement). */}
      <div ref={scratchRef} className="absolute h-0 w-0 overflow-hidden" aria-hidden />
    </div>
  );
}

export default CapabilityGraphPanel;
