'use client';

/**
 * Mock settings cell for version rows (#4443, SIM-2.2).
 *
 * One compact control block shared by Dashboard → Versions and Dashboard → Published:
 * - Switch toggling the hosted mock via `PUT /api/versions/{id}/mock` (SIM-2.1, #4422);
 *   draft versions enable a private mock gated by API key at runtime (#4446).
 * - Stable mock base URL with a copy-to-clipboard button (confirmation toast).
 * - 30-day usage sparkline fed by the SIM-1.5 (#4420) rollups; says *No requests yet* when
 *   no usage was recorded.
 * - "Scenarios" opens the SIM-4.2 (#4454) scenario override editor.
 *
 * Re-skinned in place by HIVE-6.2 (#5313) to `docs/mockups/build/versions.html`'s `.mock-cell`:
 * the switch, the label and the PRIVATE pill on one row, the mono URL with its copy button
 * under it, then Scenarios beside the 30-day sparkline. Every colour is a token now (the
 * `ver-mock-*` block in `globals.css`); the sparkline is the HIVE-2.6 metrics kit's, whose
 * empty state is the mockup's quiet *No requests yet* rather than the MCP chart frame's dashed
 * box. Nothing it does has changed, and the words beside the switch come from
 * `versionMockLabel` so the cell and its tests agree on them.
 */

import { useState } from 'react';
import { Copy, FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Switch';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/Tooltip';
import { Sparkline } from '../../ui/metrics';
import { versionMockLabel } from '../versions/versionsModel';
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
      <div className="ver-mock" data-testid={`version-mock-cell-${versionRecordId}`}>
        <div className="ver-mock__row">
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper: Radix needs a hoverable element even when the switch is disabled */}
              <span className="ver-mock__switch">
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
          <span className="ver-mock__label">{versionMockLabel(published, mockEnabled, mockPrivate)}</span>
          {mockEnabled && mockPrivate && (
            <Badge status="private" className="ver-mock__private">
              Private
            </Badge>
          )}
        </div>

        {mockEnabled && mockBaseUrl && (
          <div className="ver-mock__url" title={mockBaseUrl}>
            <code className="mono">{mockBaseUrl}</code>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ver-mock__copy"
              onClick={() => void handleCopy()}
              aria-label={`Copy mock URL for version ${versionLabel}`}
              title="Copy mock URL"
            >
              <Copy aria-hidden />
            </Button>
          </div>
        )}

        {mockEnabled && (
          <div className="ver-mock__row">
            <button
              type="button"
              onClick={() => setScenarioEditorOpen(true)}
              className="ver-mock__scenarios"
              aria-label={`Edit mock scenarios for version ${versionLabel}`}
              data-testid={`version-mock-scenarios-button-${versionRecordId}`}
            >
              <FlaskConical aria-hidden />
              Scenarios
            </button>
            <MockScenarioEditor
              versionRecordId={versionRecordId}
              projectId={projectId}
              versionLabel={versionLabel}
              open={scenarioEditorOpen}
              onOpenChange={setScenarioEditorOpen}
            />
            {usageSeries !== undefined ? (
              usageSeries.length === 0 ? (
                <span className="ver-mock__quiet" data-testid={`version-mock-no-usage-${versionRecordId}`}>
                  No requests yet
                </span>
              ) : (
                <Sparkline
                  data={usageSeries}
                  tone="ok"
                  label={`Mock requests for v${versionLabel}, last 30 days`}
                  className="ver-mock__spark"
                />
              )
            ) : null}
          </div>
        )}
      </div>
    </TooltipProvider>
  );
}
