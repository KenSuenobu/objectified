'use client';

import * as React from 'react';
import { Download, Lock, RefreshCw } from 'lucide-react';

import { Alert } from '@/app/components/ui/Alert';
import { Button } from '@/app/components/ui/Button';
import PageHeader from '@/app/components/shell/PageHeader';
import { Page, PageBody } from '@/app/components/shell/pageChrome';
import {
  AUDIT_FILTER_PREFIXES,
  AUDIT_READ_LIMIT,
  AuditEventDrawer,
  AuditTable,
  auditExportHref,
  DEFAULT_AUDIT_RANGE,
  describeAuditRead,
  fetchAuditEvents,
  type AuditEvent,
  type AuditFilter,
  type AuditRange,
} from '@/app/components/ade/audit';

/**
 * Access audit — `/ade/dashboard/audit` (HIVE-5.5, #5308).
 *
 * Authority: `docs/mockups/workspace/audit.html`, whose **Notes → Keeps (1:1)** list is this
 * ticket's acceptance criteria; DESIGN.md §5.3 (page header), §5.4 (drawer), §8 (list).
 *
 * ### What this page owns
 *
 * The read, the narrowing that is a *server* parameter (the date range), and which entry the
 * drawer is showing. How an entry is drawn is `AuditTable`, what it says in full is
 * `AuditEventDrawer`, and the rules behind both are `auditModel`.
 *
 * ### Where each narrowing is applied, and why
 *
 * * **Date range → the server**, as `since`. It bounds what is read, so it has to be the
 *   request; it is also the one narrowing the CSV export can carry.
 * * **Category and search → the browser.** The mockup asks for a **count on every chip**, and
 *   a count is a fact about the whole ledger that a `?filter=role` response cannot carry. The
 *   six categories are partitioned with `AUDIT_FILTER_PREFIXES`, the same prefixes
 *   `_AUDIT_FILTERS` uses server-side, so a chip leaves exactly the rows the old per-chip
 *   request returned — with the count the old screen could not show.
 * * **The CSV export takes the category and the range** and is generated from the database, so
 *   the evidence artefact is the ledger's own answer rather than whatever a browser is
 *   holding. A free-text search cannot be expressed as a query parameter, so when one is
 *   active the page says what the file will contain instead of quietly disagreeing with it.
 *
 * ### The read is capped, and the page says so
 *
 * One read asks for `AUDIT_READ_LIMIT` entries — the server's own ceiling, and the number its
 * CSV export uses. When that many come back the foot says so, because "no events" and "no
 * events in the most recent thousand" must not be the same screen on a page whose purpose is
 * access-review evidence.
 */

/** Where the breadcrumb's first step goes. */
const HOME_ROUTE = '/ade/dashboard';

/** The Roles page, for a role or permission event's link out of the drawer. */
const ROLES_ROUTE = '/ade/dashboard/roles';

/** The Members page, for a member event's link out of the drawer. */
const MEMBERS_ROUTE = '/ade/dashboard/members';

/**
 * Turn a caught failure into the sentence to show.
 *
 * @param error Whatever was caught.
 * @param fallback What to say when the failure carried no message.
 * @returns The sentence.
 */
function describeFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The access audit page.
 *
 * @returns The header, the ledger table, the compliance footnote and the event drawer.
 */
export default function AuditClient() {
  const [events, setEvents] = React.useState<AuditEvent[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const [filter, setFilter] = React.useState<AuditFilter>('all');
  const [range, setRange] = React.useState<AuditRange>(DEFAULT_AUDIT_RANGE);
  const [query, setQuery] = React.useState('');

  /** Which entry the drawer is showing. An id, so a refresh re-reads what it shows. */
  const [openEventId, setOpenEventId] = React.useState<string | null>(null);

  /**
   * The moment the range is measured back from, and that the drawer says "2 hours ago"
   * against.
   *
   * Owned by the page and refreshed on each read, so the bound the request carried, the rows
   * that came back and the relative time beside one of them cannot be judged against three
   * different instants.
   */
  const [now, setNow] = React.useState(() => new Date());

  const loadEvents = React.useCallback(async (activeRange: AuditRange) => {
    setLoading(true);
    setError(null);
    const at = new Date();
    try {
      setEvents(await fetchAuditEvents({ range: activeRange, now: at }));
      setNow(at);
    } catch (caught) {
      setEvents([]);
      setError(describeFailure(caught, 'Failed to load audit log'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadEvents(range);
  }, [loadEvents, range]);

  const openEvent = React.useMemo(
    () => events.find((event) => event.id === openEventId) ?? null,
    [events, openEventId]
  );

  const exportHref = auditExportHref(filter, { range, now });
  const searching = query.trim().length > 0;

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: 'Home', href: HOME_ROUTE },
          { label: 'Govern' },
          { label: 'Access audit' },
        ]}
        title="Access audit"
        description="Immutable record of every access & permission change."
        actions={
          <>
            <Button
              variant="ghost"
              title="Refresh"
              aria-label="Refresh the access ledger"
              data-testid="audit-refresh"
              disabled={loading}
              onClick={() => void loadEvents(range)}
            >
              <RefreshCw aria-hidden />
            </Button>
            <Button asChild data-testid="audit-export">
              {/* A real link, not `window.location.href` in an onClick: the endpoint answers
                  with a file, and a link is the thing a browser already knows how to
                  download, open in a new tab, or copy the address of. */}
              <a href={exportHref} download>
                <Download aria-hidden />
                Export CSV
              </a>
            </Button>
          </>
        }
      />

      <PageBody>
        {/* One error surface, not two. A refused read leaves nothing to draw, and a table
            with nothing to draw says "No audit events for this filter." — a claim about the
            workspace rather than about the request. So the banner *replaces* the table, which
            is also the state the mockup previews. */}
        {error ? (
          <Alert
            variant="error"
            data-testid="audit-error"
            actions={
              <Button variant="outline" size="sm" onClick={() => void loadEvents(range)}>
                Retry
              </Button>
            }
          >
            <span>
              <strong>Failed to load audit log.</strong> Nothing was lost — the ledger is
              append-only. {error}
            </span>
          </Alert>
        ) : (
          <AuditTable
            events={events}
            loading={loading}
            filter={filter}
            onFilterChange={setFilter}
            range={range}
            onRangeChange={setRange}
            query={query}
            onQueryChange={setQuery}
            onOpenEvent={(event) => setOpenEventId(event.id)}
            readNote={describeAuditRead(events.length, AUDIT_READ_LIMIT, range)}
          />
        )}

        <p className="aud-note" data-testid="audit-compliance-note">
          <Lock aria-hidden />
          <span>
            Entries are append-only and hash-chained; they cannot be edited or deleted,
            satisfying SOC 2 / ISO 27001 access-review evidence. Export CSV downloads the{' '}
            <strong>{filter === 'all' ? 'whole' : 'selected'}</strong> category over the chosen
            date range
            {searching ? ', and is not narrowed by the search box' : ''}
            {AUDIT_FILTER_PREFIXES[filter] ? ` (${AUDIT_FILTER_PREFIXES[filter]}*)` : ''}.
          </span>
        </p>
      </PageBody>

      <AuditEventDrawer
        event={openEvent}
        onOpenChange={(open) => !open && setOpenEventId(null)}
        ledger={events}
        now={now}
        rolesHref={ROLES_ROUTE}
        membersHref={MEMBERS_ROUTE}
      />
    </Page>
  );
}
