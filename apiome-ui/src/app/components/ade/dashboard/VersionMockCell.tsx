'use client';

/**
 * Mock settings cell for version rows (#4443, SIM-2.2).
 *
 * One compact control block shared by Dashboard → Versions and Dashboard → Published:
 * - Switch toggling the hosted mock via `PUT /api/versions/{id}/mock` (SIM-2.1, #4422);
 *   draft versions enable a private mock gated by API key at runtime (#4446).
 * - Stable mock base URL with a copy-to-clipboard button (confirmation toast).
 * - 30-day usage sparkline fed by the SIM-1.5 (#4420) rollups; renders the shared
 *   chart empty state when no usage was recorded.
 * - "Scenarios" opens the SIM-4.2 (#4454) scenario override editor.
 */

import { useState } from 'react';
import { Copy, FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '../../ui/Switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/Tooltip';
import { Sparkline } from '../../ui/mcp/charts/Sparkline';
import { MockScenarioEditor } from './MockScenarioEditor';

export interface VersionMockChange {
  /** New persisted toggle state reported by REST. */
  mockEnabled: boolean;
  /** Stable mock base URL when enabled, `null` when disabled. */
  mockBaseUrl: string | null;
  /** When true, the mock is key-gated for an unpublished draft. */
  mockPrivate?: boolean;
}

export interface VersionMockCellProps {
  /** Version record id (the `versions.id` UUID, not the semver label). */
  versionRecordId: string;
  /** Project the version belongs to (forwarded to the toggle proxy route). */
  projectId: string;
  /** Human version label (e.g. `1.2.0`), used in toast copy. */
  versionLabel: string;
  /** Whether the version is published — public mocks require publish; drafts can use private mock. */
  published: boolean;
  /** Current persisted toggle state. */
  mockEnabled: boolean;
  /** When true, the mock is key-gated for an unpublished draft (#4446). */
  mockPrivate?: boolean;
  /** Stable mock base URL when enabled; `null`/absent otherwise. */
  mockBaseUrl: string | null;
  /**
   * Chronological 30-day request counts for this version. `undefined` while usage is
   * still loading; `[]` when the version has no recorded usage (empty sparkline state).
   */
  usageSeries?: readonly number[];
  /** Called after a successful round-trip so the owner can update its row state. */
  onMockChanged: (change: VersionMockChange) => void;
}

/**
 * Render the mock toggle + URL + usage block for one version row.
 *
 * @param props - see {@link VersionMockCellProps}
 * @returns the mock settings cell contents
 */
export function VersionMockCell({
  versionRecordId,
  projectId,
  versionLabel,
  published,
  mockEnabled,
  mockBaseUrl,
  mockPrivate = false,
  usageSeries,
  onMockChanged,
}: VersionMockCellProps) {
  const [saving, setSaving] = useState(false);
  const [scenarioEditorOpen, setScenarioEditorOpen] = useState(false);

  /** Round-trip the toggle through the proxy route and report the persisted state. */
  const handleToggle = async (enabled: boolean) => {
    if (saving) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/versions/${versionRecordId}/mock`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, enabled }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.success) {
        toast.error(payload?.error || `Failed to ${enabled ? 'enable' : 'disable'} mock for v${versionLabel}.`);
        return;
      }
      const version = (payload.version ?? {}) as {
        mockEnabled?: boolean;
        mockBaseUrl?: string | null;
        mockPrivate?: boolean;
      };
      onMockChanged({
        mockEnabled: Boolean(version.mockEnabled ?? enabled),
        mockBaseUrl: version.mockBaseUrl ?? null,
        mockPrivate: Boolean(version.mockPrivate),
      });
      toast.success(
        enabled
          ? `Mock enabled for v${versionLabel} — the mock URL is ready to share.`
          : `Mock disabled for v${versionLabel}.`
      );
    } catch (error) {
      console.error('Failed to toggle version mock:', error);
      toast.error(`Failed to ${enabled ? 'enable' : 'disable'} mock for v${versionLabel}.`);
    } finally {
      setSaving(false);
    }
  };

  /** Copy the mock base URL and confirm with a toast (AC: "URL copy shows a toast"). */
  const handleCopy = async () => {
    if (!mockBaseUrl) return;
    try {
      await navigator.clipboard.writeText(mockBaseUrl);
      toast.success('Mock URL copied to clipboard.');
    } catch (error) {
      console.error('Failed to copy mock URL:', error);
      toast.error('Failed to copy mock URL to clipboard.');
    }
  };

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-1.5" data-testid={`version-mock-cell-${versionRecordId}`}>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper: Radix needs a hoverable element even when the switch is disabled */}
              <span className="inline-flex">
                <Switch
                  checked={mockEnabled}
                  disabled={saving}
                  onCheckedChange={(checked) => void handleToggle(checked)}
                  aria-label={`Mock for version ${versionLabel}`}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {published
                ? mockEnabled
                  ? 'Disable the hosted mock for this version'
                  : 'Serve spec-accurate mock responses for this version'
                : mockEnabled
                  ? 'Disable the private draft mock (requires API key at runtime)'
                  : 'Enable a private draft mock for parallel development (requires API key)'}
            </TooltipContent>
          </Tooltip>
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {mockEnabled
              ? mockPrivate
                ? 'Private mock on'
                : published
                  ? 'Mock on'
                  : 'Mock on'
              : published
                ? 'Mock off'
                : 'Draft mock off'}
          </span>
          {mockEnabled && mockPrivate && (
            <span className="text-2xs uppercase tracking-wide font-semibold text-violet-600 dark:text-violet-300 bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800 px-1.5 py-0.5 rounded">
              Private
            </span>
          )}
        </div>

        {mockEnabled && mockBaseUrl && (
          <div className="flex items-center gap-1.5">
            <code
              className="text-xs bg-gray-50 dark:bg-gray-900 px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 font-mono max-w-[14rem] truncate block"
              title={mockBaseUrl}
            >
              {mockBaseUrl}
            </code>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md transition-colors text-gray-400 hover:text-gray-600 dark:hover:text-white flex-shrink-0"
              aria-label={`Copy mock URL for version ${versionLabel}`}
              title="Copy mock URL"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {mockEnabled && (
          <>
            <button
              type="button"
              onClick={() => setScenarioEditorOpen(true)}
              className="inline-flex items-center gap-1 self-start text-xs text-indigo-600 dark:text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-300 hover:underline transition-colors"
              aria-label={`Edit mock scenarios for version ${versionLabel}`}
              data-testid={`version-mock-scenarios-button-${versionRecordId}`}
            >
              <FlaskConical className="h-3.5 w-3.5" />
              Scenarios
            </button>
            <MockScenarioEditor
              versionRecordId={versionRecordId}
              projectId={projectId}
              versionLabel={versionLabel}
              open={scenarioEditorOpen}
              onOpenChange={setScenarioEditorOpen}
            />
          </>
        )}

        {mockEnabled && usageSeries !== undefined && (
          <Sparkline
            data={usageSeries}
            tone="emerald"
            title={`Mock requests for v${versionLabel}, last 30 days`}
            className="h-8 w-28"
          />
        )}
      </div>
    </TooltipProvider>
  );
}
