'use client';

import * as React from 'react';
import {
  ArrowRight,
  BadgeCheck,
  Check,
  CircleAlert,
  Copy,
  Link2Off,
  Lock,
  Shield,
  Users,
} from 'lucide-react';

import { Avatar } from '@/app/components/ui/Avatar';
import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from '@/app/components/ui/Drawer';
import { useClipboardCopy } from '@/app/hooks/useClipboardCopy';

import {
  AUDIT_CHAIN_MESSAGES,
  auditActorLabel,
  auditBadgeTone,
  auditChainPosition,
  auditChange,
  auditDetailEntries,
  auditEventJson,
  auditFamily,
  describeAuditEvent,
  formatAuditExactTimestamp,
  formatAuditRelative,
  NO_VALUE,
  type AuditEvent,
} from './auditModel';

/**
 * The event detail drawer — HIVE-5.5 (#5308).
 *
 * Authority: `docs/mockups/workspace/audit.html` `#event-drawer`; DESIGN.md §5.4.
 *
 * This is the "adds" half of the ticket: the screen it joins had **no** detail surface, so an
 * entry was five cells and everything else the ledger recorded about it — the structured
 * `detail`, the origin, and the two hashes that make the record tamper-evident — was either
 * squeezed into the Target cell or unreachable.
 *
 * ### Every field here is a real column
 *
 * Actor, target, source, `detail` and the two hashes are `apiome.access_audit` rows; the JSON
 * block is the record as it arrived, which is what makes "shows the full event payload
 * without truncation" a property of the code rather than a promise.
 *
 * The mockup's Request section — request id, IP, user agent, session, 2FA — is deliberately
 * **absent**. Nothing stores any of it: `access_audit` has no request columns, and the auth
 * ledger that does hash an IP (`auth_events`, OLO-1.6) is a different table with a different
 * chain. A section that showed five plausible values for an auditor to rely on would be the
 * most damaging thing this drawer could contain.
 *
 * ### The chain claim is checked, or it is not made
 *
 * The mockup's footnote reads "Chain verified · 128 entries". What can honestly be said from
 * a browser is narrower: whether *this* entry's `prev_hash` is the `entry_hash` of the entry
 * written immediately before it, among the entries that were read. {@link auditChainPosition}
 * answers exactly that, and the four other answers it can give ("first in the chain", "the
 * previous entry is outside this view", "broken", "no hashes") each say what was and was not
 * established.
 */

/** Props for {@link AuditEventDrawer}. */
export interface AuditEventDrawerProps {
  /** The entry being looked at; `null` closes the drawer. */
  event: AuditEvent | null;
  /** Called with `false` when the sheet is dismissed. */
  onOpenChange: (open: boolean) => void;
  /**
   * The ledger as it was read, newest first.
   *
   * The chain check needs the unfiltered response in server order — see
   * {@link auditChainPosition}, which answers `not-loaded` rather than guessing when it is
   * given anything else.
   */
  ledger: readonly AuditEvent[];
  /** The moment "2 hours ago" is measured from. */
  now: Date;
  /** Where the Roles page lives, for a role event's link out. */
  rolesHref: string;
  /** Where the Members page lives, for a member event's link out. */
  membersHref: string;
}

/**
 * A section of the sheet: a caps heading and its content.
 *
 * @param props.title The heading.
 * @param props.children The content.
 * @returns The section.
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="aud-caps mb-2">{title}</h3>
      {children}
    </section>
  );
}

/** The tone the chain note takes, per status — the one place the status becomes a colour. */
const CHAIN_TONE = {
  linked: 'ok',
  broken: 'danger',
  'chain-start': 'neutral',
  'not-loaded': 'neutral',
  unavailable: 'neutral',
} as const;

/**
 * The copy-JSON button.
 *
 * A component of its own so the "copied" acknowledgement belongs to the button that was
 * pressed and resets on its own, which is what `useClipboardCopy` owns.
 *
 * @param props.json The payload to copy.
 * @returns The button.
 */
function CopyJsonButton({ json }: { json: string }) {
  const { copied, copy } = useClipboardCopy();
  return (
    <Button
      variant="ghost"
      size="sm"
      data-testid="audit-copy-json"
      aria-label={copied ? 'Copied the event JSON' : 'Copy the event JSON'}
      onClick={() => void copy(json)}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

/**
 * The event detail sheet.
 *
 * @param props See {@link AuditEventDrawerProps}.
 * @returns The drawer.
 */
export default function AuditEventDrawer({
  event,
  onOpenChange,
  ledger,
  now,
  rolesHref,
  membersHref,
}: AuditEventDrawerProps) {
  const open = event !== null;
  const family = event ? auditFamily(event.action) : 'other';
  const chain = event ? auditChainPosition(ledger, event) : null;
  const details = event ? auditDetailEntries(event.detail) : [];
  const change = event ? auditChange(event.detail) : null;
  const json = event ? auditEventJson(event) : '';
  const actor = event ? auditActorLabel(event) : '';

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        size="lg"
        data-testid="audit-drawer"
        // Radix points the sheet at a description id whether or not one is rendered; this
        // drawer's sub-line is the timestamp row rather than a `DrawerDescription`, so the
        // reference has to be cleared or it dangles (HIVE-2.2's rule).
        aria-describedby={undefined}
      >
        {event && (
          <>
            <DrawerHeader className="flex-row items-start gap-3">
              <div className="min-w-0 flex-1">
                <DrawerTitle className="aud-drawer-title">
                  <Badge variant={auditBadgeTone(event.action)} size="lg" mono>
                    {event.action}
                  </Badge>
                  <span className="aud-drawer-id mono" data-testid="audit-drawer-id">
                    {event.id}
                  </span>
                </DrawerTitle>
                <p className="aud-drawer-when">
                  {formatAuditExactTimestamp(event.created_at)} ·{' '}
                  {formatAuditRelative(event.created_at, now)}
                </p>
              </div>
            </DrawerHeader>

            <DrawerBody className="space-y-6">
              <p className="aud-callout" data-testid="audit-drawer-summary">
                {describeAuditEvent(event)}
              </p>

              <Section title="Actor">
                <div className="aud-party">
                  <Avatar name={actor} seed={event.actor_id ?? actor} aria-hidden />
                  <span className="aud-party__text">
                    <span className="aud-party__name">{actor}</span>
                    <span className="aud-party__meta mono">
                      {event.actor_id || 'no user id recorded'}
                    </span>
                  </span>
                  <Badge variant="outline">{event.source || NO_VALUE}</Badge>
                </div>
              </Section>

              <Section title="Target">
                <div className="aud-party">
                  <span className="tnt-icon-tile" data-tone={family === 'member' ? 'accent' : 'honey'}>
                    {family === 'member' ? <Users aria-hidden /> : <Shield aria-hidden />}
                  </span>
                  <span className="aud-party__text">
                    <span className="aud-party__name">{event.target || NO_VALUE}</span>
                    {/* The before → after pair, when the entry recorded one. Nothing when it
                        did not: repeating the action string under the target it belongs to
                        adds a second copy of what the header badge already says. */}
                    {change ? (
                      <span className="aud-change" data-testid="audit-drawer-change">
                        <span className="aud-change__before">{change.before}</span>
                        <ArrowRight className="aud-change__arrow" aria-hidden />
                        <span className="aud-change__after">{change.after}</span>
                      </span>
                    ) : null}
                  </span>
                </div>
              </Section>

              <Section title="Recorded detail">
                {details.length === 0 ? (
                  <p className="aud-quiet">This entry was written without structured detail.</p>
                ) : (
                  <dl className="aud-kv" data-testid="audit-drawer-detail">
                    {details.map((entry) => (
                      <React.Fragment key={entry.key}>
                        <dt className="mono">{entry.key}</dt>
                        <dd>{entry.value}</dd>
                      </React.Fragment>
                    ))}
                  </dl>
                )}
              </Section>

              <Section title="Hash chain">
                <div className="aud-chain" data-testid="audit-drawer-chain">
                  <div className="aud-chain__row">
                    <span className="aud-chain__label">Previous entry</span>
                    <code className="aud-hash">{chain?.previousHash ?? NO_VALUE}</code>
                  </div>
                  <div className="aud-chain__row">
                    <span className="aud-chain__label">This entry</span>
                    <code className="aud-hash">{chain?.entryHash ?? NO_VALUE}</code>
                  </div>
                </div>
                {chain && (
                  <p
                    className="aud-chain__note"
                    data-tone={CHAIN_TONE[chain.status]}
                    data-chain-status={chain.status}
                  >
                    {chain.status === 'linked' ? (
                      <BadgeCheck aria-hidden />
                    ) : chain.status === 'broken' ? (
                      <CircleAlert aria-hidden />
                    ) : (
                      <Link2Off aria-hidden />
                    )}
                    {AUDIT_CHAIN_MESSAGES[chain.status]}
                  </p>
                )}
              </Section>

              <Section title="Event JSON">
                <div className="aud-json-head">
                  <span className="aud-quiet">The entry exactly as the ledger stores it.</span>
                  <CopyJsonButton json={json} />
                </div>
                {/* `<pre>`, not a viewer that folds or clamps: the acceptance criterion is
                    that the payload is shown *without truncation*, and a block that scrolls
                    inside its own box is the only way to keep that true at every font scale
                    without widening the sheet.

                    Because it scrolls, it is a `region` the keyboard can reach (WCAG 2.1.1) —
                    the same treatment `DataTable` gives its own scrolling wrapper, and a
                    serious axe `scrollable-region-focusable` violation without it. */}
                <pre
                  className="aud-json mono"
                  data-testid="audit-drawer-json"
                  tabIndex={0}
                  role="region"
                  aria-label={`JSON for event ${event.id}`}
                >
                  {json}
                </pre>
              </Section>
            </DrawerBody>

            <DrawerFooter>
              <span className="aud-readonly">
                <Lock aria-hidden />
                Read-only · append-only ledger
              </span>
              {family === 'role' || family === 'permission' ? (
                <Button variant="outline" asChild>
                  <a href={rolesHref} data-testid="audit-drawer-roles-link">
                    <Shield aria-hidden />
                    Open roles
                  </a>
                </Button>
              ) : null}
              {family === 'member' ? (
                <Button variant="outline" asChild>
                  <a href={membersHref} data-testid="audit-drawer-members-link">
                    <Users aria-hidden />
                    Open members
                  </a>
                </Button>
              ) : null}
            </DrawerFooter>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}
