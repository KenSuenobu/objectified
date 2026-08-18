'use client';

/**
 * The Done step of an MCP import (HIVE-6.4, #5315).
 *
 * MCP is the one source that never reaches Analyze or Preview — it registers an endpoint, scans
 * it, and lands. So its Done step is its own surface, and the two outcomes it can land on are
 * genuinely different things: a *cataloged* server whose capabilities are now browsable, and an
 * *added* one that connected badly enough to have nothing in it yet.
 *
 * Authority: `docs/mockups/build/import-wizard.html` §Step 5, whose title variants are the same
 * two sentences.
 */

import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react';

import { EmptyState } from '@/app/components/ui/EmptyState';

export interface McpImportDonePanelProps {
  /** The endpoint's id, once it exists. */
  endpointId: string | null;
  /** Its display name. */
  endpointName: string;
  /** Whether discovery committed a catalog version. */
  succeeded: boolean;
  /** Called before navigating away, so the dialog can settle its own state. */
  onNavigate: () => void;
}

/**
 * The summary.
 *
 * Built on `EmptyState` rather than a bespoke centred column because that is what the feedback
 * set is for — the same art, the same title/description rhythm and the same tone vocabulary the
 * rest of the app uses when a surface has one thing to say. A landed import takes the `honey`
 * art (DESIGN.md §2 keeps honey for brand moments, and this is one); an incomplete scan takes
 * `danger`, the nearest the three-tone art offers to the mockup's amber.
 *
 * @param props See {@link McpImportDonePanelProps}.
 * @returns The MCP Done step.
 */
export function McpImportDonePanel({
  endpointId,
  endpointName,
  succeeded,
  onNavigate,
}: McpImportDonePanelProps) {
  return (
    <EmptyState
      tone={succeeded ? 'honey' : 'danger'}
      icon={succeeded ? <CheckCircle2 /> : <AlertTriangle />}
      title={succeeded ? `${endpointName} cataloged` : `${endpointName} added`}
      description={
        succeeded
          ? 'Discovery committed catalog version 1. Its tools, resources, and prompts are now available under MCP Servers.'
          : 'Discovery did not complete, so this server has no cataloged capabilities yet. Fix its connection or credentials, then re-run discovery from its page.'
      }
      action={
        endpointId ? (
          <Link
            href={`/ade/dashboard/mcp/${endpointId}`}
            onClick={onNavigate}
            className="inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline"
          >
            View endpoint
            <ArrowRight className="size-[var(--icon-dense)]" aria-hidden />
          </Link>
        ) : undefined
      }
    />
  );
}

export default McpImportDonePanel;
