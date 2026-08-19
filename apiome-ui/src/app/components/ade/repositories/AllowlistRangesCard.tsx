'use client';

/**
 * The workspace's own webhook ranges (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/webhook-allowlist.html` — *Additional ranges for this
 * workspace*: the two-field add row, the entry list with its Disable/Enable and trash
 * controls, and the *Remove {cidr}?* confirm the **Notes → Adds** list introduces.
 *
 * ### Why removing asks and disabling does not
 *
 * Both edits change the filter; only one of them is irreversible. Disabling a range leaves the
 * row, its reason and its date on the page, so an operator who disabled the wrong one can see
 * what they did and undo it in a click. Removing it destroys the only record of why it was
 * ever allowed — and it narrows what an unauthenticated endpoint accepts, so a delivery starts
 * failing minutes later with nothing on screen to explain it. That is the asymmetry the
 * confirm marks, and it is the ticket's "allowlist edits confirm before weakening enforcement"
 * criterion for this card.
 *
 * ### Why validation runs before the request
 *
 * `validateCidr` applies the *same* rule the server does, not a looser one — a value with host
 * bits set is rejected rather than silently widened, because an operator who meant one host
 * and got 256 would never learn it from this screen. The server re-validates regardless; this
 * only exists so the answer arrives while the field is still focused.
 */

import * as React from 'react';
import { ListPlus, Plus, Trash2 } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/AlertDialog';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { FormField } from '@/app/components/ui/FormField';
import { Input } from '@/app/components/ui/Input';

import {
  ADDITIONAL_RANGES_DESC,
  ADDITIONAL_RANGES_EMPTY,
  ADDITIONAL_RANGES_TITLE,
  NO_RANGE_DESCRIPTION,
  RANGE_REASON_REQUIRED,
  type IpAllowlistEntry,
  formatTimestamp,
  removeRangeConfirm,
  validateCidr,
} from './webhookAllowlistModel';

export interface AllowlistRangesCardProps {
  /** The workspace's entries, as the server last reported them. */
  entries: readonly IpAllowlistEntry[];
  /** True while a mutation is in flight — every control is disabled for its duration. */
  busy: boolean;
  /** Add a range. Resolves true when the server accepted it, which is what clears the form. */
  onAdd: (cidr: string, description: string) => Promise<boolean>;
  /** Flip one entry's `enabled` flag. */
  onToggle: (entry: IpAllowlistEntry) => void;
  /** Remove one entry, after the confirm has been answered. */
  onRemove: (entry: IpAllowlistEntry) => void;
}

/**
 * Render the card. See {@link AllowlistRangesCardProps}.
 *
 * @returns The card, and the remove confirm it opens.
 */
export function AllowlistRangesCard({
  entries,
  busy,
  onAdd,
  onToggle,
  onRemove,
}: AllowlistRangesCardProps) {
  const [cidr, setCidr] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [cidrError, setCidrError] = React.useState<string | null>(null);
  // The entry whose confirm is open. Holding the entry rather than a boolean is what lets the
  // dialog name the exact range: a confirm that says "this range" is one an operator can
  // answer without having checked which row they clicked.
  const [pendingRemoval, setPendingRemoval] = React.useState<IpAllowlistEntry | null>(null);

  const submit = React.useCallback(async () => {
    const invalid = validateCidr(cidr);
    if (invalid) {
      setCidrError(invalid);
      return;
    }
    if (!description.trim()) {
      setCidrError(RANGE_REASON_REQUIRED);
      return;
    }
    setCidrError(null);
    const accepted = await onAdd(cidr.trim(), description.trim());
    if (accepted) {
      setCidr('');
      setDescription('');
    }
  }, [cidr, description, onAdd]);

  const confirm = pendingRemoval ? removeRangeConfirm(pendingRemoval.cidr) : null;

  return (
    <>
      <Card aria-label={ADDITIONAL_RANGES_TITLE} data-testid="allowlist-ranges">
        <CardHeader className="wal-ranges__head">
          <CardTitle className="wal-ranges__title">
            <ListPlus aria-hidden />
            {ADDITIONAL_RANGES_TITLE}
          </CardTitle>
          <span className="wal-ranges__count">
            {entries.length.toLocaleString()} range{entries.length === 1 ? '' : 's'}
          </span>
        </CardHeader>

        <CardContent>
          <p className="wal-ranges__desc">{ADDITIONAL_RANGES_DESC}</p>

          <div className="wal-add">
            <FormField
              className="wal-add__field"
              label="Address or CIDR"
              htmlFor="allowlist-cidr"
              error={cidrError ?? undefined}
            >
              <Input
                id="allowlist-cidr"
                className="mono"
                value={cidr}
                onChange={(event) => {
                  setCidr(event.target.value);
                  if (cidrError) setCidrError(null);
                }}
                placeholder="203.0.113.0/24"
                data-testid="allowlist-cidr"
              />
            </FormField>

            <FormField className="wal-add__field" label="Why" htmlFor="allowlist-description">
              <Input
                id="allowlist-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Self-hosted GitLab runner"
                data-testid="allowlist-description"
              />
            </FormField>

            <Button
              className="wal-add__submit"
              disabled={busy}
              onClick={() => void submit()}
              data-testid="allowlist-add"
            >
              <Plus aria-hidden />
              Allow range
            </Button>
          </div>
        </CardContent>

        {entries.length > 0 ? (
          <ul className="wal-entries">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="wal-entry"
                data-testid="allowlist-entry"
                data-cidr={entry.cidr}
                data-enabled={entry.enabled ? 'true' : 'false'}
              >
                <span className="wal-cidr mono">{entry.cidr}</span>
                <span className="wal-entry__meta">
                  {entry.description || (
                    <span className="wal-entry__nodesc">{NO_RANGE_DESCRIPTION}</span>
                  )}{' '}
                  · added {formatTimestamp(entry.createdAt)}
                  {entry.enabled ? null : (
                    <>
                      {' · '}
                      <Badge variant="outline">disabled</Badge>
                    </>
                  )}
                </span>
                <span className="wal-entry__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onToggle(entry)}
                    data-testid="allowlist-toggle"
                  >
                    {entry.enabled ? 'Disable' : 'Enable'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Remove ${entry.cidr}`}
                    onClick={() => setPendingRemoval(entry)}
                    data-testid="allowlist-remove"
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <CardContent>
            <p className="wal-ranges__empty" data-testid="allowlist-empty">
              {ADDITIONAL_RANGES_EMPTY}
            </p>
          </CardContent>
        )}
      </Card>

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
      >
        <AlertDialogContent data-testid="allowlist-remove-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title ?? ''}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.description ?? ''}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={() => {
                if (pendingRemoval) onRemove(pendingRemoval);
                setPendingRemoval(null);
              }}
              data-testid="allowlist-remove-confirm-action"
            >
              {confirm?.confirmLabel ?? 'Remove range'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default AllowlistRangesCard;
