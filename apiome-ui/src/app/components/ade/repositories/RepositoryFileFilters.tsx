'use client';

/**
 * The Files tab's filter toolbar (HIVE-7.5, #5322).
 *
 * Authority: `docs/mockups/sources/repository-detail.html` §Files → filter toolbar — the
 * importable preset, a comma-separated glob, an optional regex, three switches, and
 * Reset / Apply.
 *
 * ### Glob and regex are exclusive, and now they say so
 *
 * The listing endpoint applies a regex *or* a preset-and-glob, never both. The toolbar this
 * replaces expressed that by disabling the glob field whenever the regex box had anything in
 * it — a control that goes inert with no explanation, which reads as a bug. The exclusivity is
 * unchanged (it is the endpoint's rule, and {@link repositoryFilesQuery} applies it), but the
 * disabled field now carries the reason as a hint under it, and the *preset* is disabled too:
 * it was left live before, so a reader could pick "OpenAPI" and watch nothing happen.
 *
 * ### Apply is not the only way to filter
 *
 * The text fields debounce and re-read on their own — {@link FILE_FILTER_DEBOUNCE_MS} — so
 * *Apply filter* is a re-read rather than the commit of a pending edit. It is kept because the
 * mockup keeps it and because a reader who has typed a long glob wants to be able to ask
 * rather than wait, but it is `outline`, not the primary: the primary action on this tab is
 * *Import selected*, and DESIGN.md §7 gives a surface one.
 */

import * as React from 'react';

import { Button } from '@/app/components/ui/Button';
import { Input } from '@/app/components/ui/Input';
import { Label } from '@/app/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/Select';

import {
  REPOSITORY_FILE_PRESETS,
  type RepositoryFileFilterState,
} from './repositoryDetailModel';

/** Why the preset and glob fields go inert while a regex is present. */
export const REGEX_OVERRIDES_GLOB_HINT =
  'A regex replaces the preset and glob — clear it to use them.';

export interface RepositoryFileFiltersProps {
  /** The current toolbar state. */
  value: RepositoryFileFilterState;
  /** Patch one or more fields. */
  onChange: (patch: Partial<RepositoryFileFilterState>) => void;
  /** Return every field to its default. */
  onReset: () => void;
  /** Re-read now, without waiting for the debounce. */
  onApply: () => void;
  /** True while a read is in flight — Apply goes inert so it cannot queue a second. */
  busy?: boolean;
}

/**
 * Render the toolbar. See {@link RepositoryFileFiltersProps}.
 *
 * @returns The four fields, the three switches, and the two actions.
 */
export function RepositoryFileFilters({
  value,
  onChange,
  onReset,
  onApply,
  busy = false,
}: RepositoryFileFiltersProps) {
  const regexActive = value.regex.trim() !== '';

  return (
    <div className="repo-files-filters" data-testid="repository-file-filters">
      <div className="repo-files-filters__fields">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repository-file-preset">Importable preset</Label>
          <Select
            value={value.preset}
            disabled={regexActive}
            onValueChange={(preset) => onChange({ preset })}
          >
            <SelectTrigger id="repository-file-preset" data-testid="repository-file-preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REPOSITORY_FILE_PRESETS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repository-file-glob">Glob filter (comma-separated)</Label>
          <Input
            id="repository-file-glob"
            className="mono"
            value={value.glob}
            disabled={regexActive}
            placeholder="**/openapi*.yaml, **/arazzo/*.yml"
            onChange={(e) => onChange({ glob: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="repository-file-regex">Regex (optional)</Label>
          <Input
            id="repository-file-regex"
            className="mono"
            value={value.regex}
            placeholder="e.g. v\d+\.yaml$"
            onChange={(e) => onChange({ regex: e.target.value })}
          />
        </div>
      </div>

      {regexActive ? (
        <p className="repo-det-note" data-testid="repository-file-regex-hint">
          {REGEX_OVERRIDES_GLOB_HINT}
        </p>
      ) : null}

      <div className="repo-files-filters__switches">
        <label className="repo-files-check">
          <input
            type="checkbox"
            checked={value.hideNonImportable}
            onChange={(e) => onChange({ hideNonImportable: e.target.checked })}
          />
          Hide non-importable
        </label>
        <label className="repo-files-check">
          <input
            type="checkbox"
            checked={value.includeHidden}
            onChange={(e) => onChange({ includeHidden: e.target.checked })}
          />
          Recurse hidden dirs
        </label>
        <label className="repo-files-check">
          <input
            type="checkbox"
            checked={value.skipVendor}
            onChange={(e) => onChange({ skipVendor: e.target.checked })}
          />
          Skip vendored / node_modules
        </label>
        <div className="repo-files-filters__actions">
          <Button type="button" variant="ghost" size="sm" onClick={onReset}>
            Reset
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onApply}
            data-testid="repository-file-apply"
          >
            Apply filter
          </Button>
        </div>
      </div>
    </div>
  );
}

export default RepositoryFileFilters;
