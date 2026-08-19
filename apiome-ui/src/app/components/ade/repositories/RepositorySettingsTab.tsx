'use client';

/**
 * The repository's own settings (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Settings — the *Source* card, the
 * *Scan cadence* switch over its disabled fieldset, *Refresh conflicts* (which stays
 * {@link RepositoryConflictPolicy}, its own RAR-4.5 panel), *Default importer mappings*, and
 * the danger zone.
 *
 * ### The one thing this fixes rather than restyles
 *
 * Three of the five cards here draw controls that do nothing yet — a subpath glob, a schedule,
 * a webhook, an "Add mapping" button. The screen this replaces marked them by dimming: a
 * `fieldset disabled` at `opacity-70`, a `disabled` input, a `disabled` button. Dimming says
 * "not now"; it does not say *why*, and a reader who cannot see the difference between a
 * disabled control and an enabled one on their display gets no signal at all.
 *
 * So every stub here carries its sentence in text, from the shared vocabulary in
 * `repositoryDetailModel` — {@link SUBPATH_GLOB_STUB_NOTE} and the four beside it — and the
 * dimming is the second channel rather than the only one. That is the ticket's "stubbed
 * controls remain visually honest" criterion, and DESIGN.md §6 besides.
 */

import * as React from 'react';
import { Plus } from 'lucide-react';

import { Button } from '@/app/components/ui/Button';
import { Card, CardContent } from '@/app/components/ui/Card';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import { Switch } from '@/app/components/ui/Switch';
import { Badge } from '@/app/components/ui/Badge';

import { ProviderGlyph } from './ProviderBadge';
import {
  AUTO_REFRESH_DESCRIPTION,
  IMPORTER_MAPPINGS_EMPTY,
  IMPORTER_MAPPINGS_STUB_NOTE,
  REMOVE_REPOSITORY_DESCRIPTION,
  SCHEDULE_STUB_VALUE,
  SUBPATH_GLOB_STUB_NOTE,
  WEBHOOK_STUB_NOTE,
  repositorySourceLine,
} from './repositoryDetailModel';
import type { DashboardRepository } from './repositoriesModel';

export interface RepositorySettingsTabProps {
  /** The repository being configured. */
  repository: DashboardRepository;
  /** Its page on the provider's website, when there is one. */
  webUrl: string | null;
  /** True while the auto-refresh write is in flight. */
  savingAutoRefresh: boolean;
  /** Flip this repository's auto-refresh opt-out. */
  onToggleAutoRefresh: (next: boolean) => void;
  /** Open the remove confirm. */
  onRemove: () => void;
  /** True while the delete is in flight. */
  removing: boolean;
  /** The RAR-4.5 conflict-policy panel, passed in so this tab owns no data of its own. */
  conflictPolicy: React.ReactNode;
}

/** The importer-mappings table's four columns. */
const MAPPING_COLUMNS = ['Path glob', 'Detected kind', 'Default project', 'Actions'] as const;

/**
 * Render the Settings tab. See {@link RepositorySettingsTabProps}.
 *
 * @returns The five cards, in the mockup's order.
 */
export function RepositorySettingsTab({
  repository,
  webUrl,
  savingAutoRefresh,
  onToggleAutoRefresh,
  onRemove,
  removing,
  conflictPolicy,
}: RepositorySettingsTabProps) {
  const autoRefreshOn = repository.auto_refresh_enabled ?? true;

  return (
    <div className="flex max-w-[57.5rem] flex-col gap-6" data-testid="repository-settings-tab">
      <Card data-testid="repository-settings-source">
        <CardContent className="flex flex-col gap-3">
          <h3 className="repo-det-card__title">Source</h3>
          <dl className="repo-set-kv">
            <dt>Provider</dt>
            <dd className="flex items-center gap-2" data-provider={repository.provider}>
              <ProviderGlyph provider={repository.provider} />
              {repositorySourceLine(repository.provider, repository.source)}
            </dd>

            <dt>Clone URL</dt>
            <dd className="flex flex-wrap items-center gap-3">
              <span className="mono text-xs">{repository.clone_url ?? '—'}</span>
              {webUrl ? (
                <a
                  href={webUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="repo-det-link"
                >
                  Open in browser →
                </a>
              ) : null}
            </dd>

            <dt>
              <Label htmlFor="repository-default-branch">Default branch</Label>
            </dt>
            <dd>
              <Input
                id="repository-default-branch"
                readOnly
                aria-readonly="true"
                value={repository.default_branch}
                className="mono max-w-[12rem]"
              />
            </dd>

            <dt>
              <Label htmlFor="repository-subpath-glob">Subpath glob (optional)</Label>
            </dt>
            <dd className="flex flex-col gap-1">
              <Input
                id="repository-subpath-glob"
                disabled
                placeholder="e.g. specs/**"
                className="mono max-w-[18rem]"
              />
              <p className="repo-det-note" data-testid="repository-subpath-stub">
                {SUBPATH_GLOB_STUB_NOTE}
              </p>
            </dd>
          </dl>
        </CardContent>
      </Card>

      <Card data-testid="repository-settings-cadence">
        <CardContent className="flex flex-col gap-4">
          <h3 className="repo-det-card__title">Scan cadence</h3>
          <div className="repo-set-switch">
            <div className="repo-set-switch__text">
              <span className="flex items-center gap-2 text-sm font-medium text-fg">
                <Label htmlFor="repository-auto-refresh">Auto-refresh</Label>
                <Badge variant={autoRefreshOn ? 'ok' : 'outline'}>
                  {autoRefreshOn ? 'Enabled' : 'Disabled'}
                </Badge>
              </span>
              <p className="repo-det-note">{AUTO_REFRESH_DESCRIPTION}</p>
            </div>
            <Switch
              id="repository-auto-refresh"
              checked={autoRefreshOn}
              disabled={savingAutoRefresh}
              onCheckedChange={onToggleAutoRefresh}
              aria-label="Toggle auto-refresh for this repository"
            />
          </div>

          <fieldset disabled className="repo-set-stub" data-testid="repository-cadence-stub">
            <div className="repo-set-stub__grid">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="repository-schedule">Schedule</Label>
                <Input id="repository-schedule" readOnly value={SCHEDULE_STUB_VALUE} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="repository-webhook">Webhook</Label>
                <Input id="repository-webhook" readOnly value={WEBHOOK_STUB_NOTE} />
              </div>
            </div>
          </fieldset>
          <p className="repo-det-note">
            Scheduling and webhook secrets are a product decision — a poll interval against
            provider push hooks. Neither control is wired, and both say so above.
          </p>
        </CardContent>
      </Card>

      {conflictPolicy}

      <Card data-testid="repository-settings-mappings">
        <CardContent className="flex flex-col gap-3">
          <h3 className="repo-det-card__title">Default importer mappings</h3>
          <p className="repo-det-note">{IMPORTER_MAPPINGS_STUB_NOTE}</p>
          <div className="repo-det-table-scroll">
            <table className="repo-det-table table-density table-dense">
              <thead>
                <tr>
                  {MAPPING_COLUMNS.map((column) => (
                    <th key={column} scope="col">
                      {column === 'Actions' ? <span className="sr-only">Actions</span> : column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={MAPPING_COLUMNS.length} className="repo-det-table__state">
                    {IMPORTER_MAPPINGS_EMPTY}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div>
            <Button type="button" variant="outline" size="sm" disabled>
              <Plus aria-hidden />
              Add mapping
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="repo-set-danger" data-testid="repository-danger-zone">
        <CardContent className="flex flex-col gap-3">
          <h3 className="repo-set-danger__title">Danger zone</h3>
          <div className="repo-set-danger__row">
            <p className="repo-set-danger__copy">{REMOVE_REPOSITORY_DESCRIPTION}</p>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={removing}
              onClick={onRemove}
              data-testid="repository-remove"
            >
              Remove repository
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default RepositorySettingsTab;
