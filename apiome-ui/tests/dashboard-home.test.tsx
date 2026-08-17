/**
 * Home — `/ade/dashboard` (HIVE-4.6, #5300).
 *
 * The ticket is a redesign of a page that already worked, so this suite is ordered by its
 * acceptance criteria rather than by the page's layout.
 *
 * 1. **Preserved exactly** — the six stats with their subtitles, the ten activity rows with
 *    their icons, tenant badge and relative time, and the loading skeletons for both.
 * 2. **No empty grid regions** — the aside is populated at the same time as the main column, so
 *    the two-column body has nothing blank in it. (Whether it *reflows* is a stylesheet question,
 *    answered by `dashboard-home-css.test.ts` and by `e2e/hive-home.spec.ts`.)
 * 3. **Needs attention resolves to real routes, and is hidden when empty.**
 * 4. **axe: zero serious/critical violations**, on the loaded page and on the loading one.
 *
 * What it cannot answer is how any of it *looks*: jsdom compiles no stylesheet. The CSS suite
 * reads `globals.css` instead.
 */

import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';

import { ATTENTION_HREF, type DashboardHome } from '@lib/db/dashboard-home-model';

/** A real anchor, with navigation suppressed — jsdom logs an error rather than navigating. */
jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={typeof href === 'string' ? href : '#'} onClick={(event) => event.preventDefault()} {...rest}>
      {children}
    </a>
  ),
}));

/** The session the page renders against; a test may replace it before rendering. */
const sessionUser: { current: Record<string, unknown> | null } = { current: null };

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: sessionUser.current ? { user: sessionUser.current } : null,
    status: sessionUser.current ? 'authenticated' : 'unauthenticated',
    update: jest.fn(),
  }),
  AuthSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));

/** The three server actions the page loads through. Each test decides what they resolve to. */
const mockGetDashboardStats = jest.fn<Promise<string>, [string]>();
const mockGetRecentActivity = jest.fn<Promise<string>, [string, number]>();
const mockGetDashboardHome = jest.fn<Promise<DashboardHome>, []>();

jest.mock('@lib/db/helper', () => ({
  getDashboardStats: (userId: string) => mockGetDashboardStats(userId),
  getRecentActivity: (userId: string, limit: number) => mockGetRecentActivity(userId, limit),
}));

jest.mock('@lib/db/dashboard-home', () => ({
  getDashboardHomeForSession: () => mockGetDashboardHome(),
}));

// The Designer is not configured in the test environment, so the checklist shows its three core
// steps — the pre-existing behaviour `FirstRunChecklist.test.tsx` covers in both configurations.
import Dashboard from '@/app/ade/dashboard/page';

/** The statistics payload, as `getDashboardStats` serialises it. */
const STATS = {
  total_tenants: 3,
  admin_tenants: 2,
  total_projects: 3,
  created_projects: 3,
  total_versions: 14,
  created_versions: 9,
  published_versions: 5,
  total_classes: 128,
  total_properties: 1042,
  total_class_properties: 962,
  last_activity: '2026-08-12T10:00:00.000Z',
};

/** Ten activity rows, two of each kind and then some, as the page asks for ten. */
const ACTIVITY = Array.from({ length: 10 }, (_, index) => ({
  type: (['project', 'version', 'class', 'property'] as const)[index % 4],
  id: `activity-${index}`,
  name: `Thing ${index}`,
  description: null,
  created_at: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
  tenant_name: index % 2 === 0 ? 'Acme Corp' : 'Globex Labs',
  tenant_slug: index % 2 === 0 ? 'acme' : 'globex',
}));

/** A full payload for the added panels. */
const HOME: DashboardHome = {
  workspaceName: 'Acme Corp',
  continueProjects: [
    {
      projectId: 'p-1',
      projectName: 'Payments API',
      tenantName: 'Acme Corp',
      versionLabel: 'v2.4.0',
      status: 'draft',
      qualityScore: 88,
      qualityGrade: 'B',
      classCount: 18,
      propertyCount: 42,
      touchedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      touchedKind: 'edited',
    },
    {
      projectId: 'p-2',
      projectName: 'Orders Service',
      tenantName: 'Globex Labs',
      versionLabel: 'v1.9.2',
      status: 'published',
      qualityScore: 94,
      qualityGrade: 'A',
      classCount: 14,
      propertyCount: 32,
      touchedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      touchedKind: 'published',
    },
  ],
  attention: [
    {
      id: 'sunset:v-1',
      kind: 'sunset',
      tone: 'warn',
      title: 'Orders Service v1.4.0 sunsets in 12 days',
      detail: 'Still published — move consumers to a successor',
      href: ATTENTION_HREF.sunset,
      urgency: 12,
    },
    {
      id: 'lint:v-9',
      kind: 'lint',
      tone: 'danger',
      title: '4 blocking lint findings on Payments API v2.4.0',
      detail: 'The publish gate will fail until these are cleared',
      href: ATTENTION_HREF.lint,
      urgency: 0,
    },
    {
      id: 'key:k-1',
      kind: 'key',
      tone: 'warn',
      title: 'API key ci-deploy expires in 2 days',
      detail: 'Acme Corp — rotate it before it breaks CI',
      href: ATTENTION_HREF.key,
      urgency: 2,
    },
  ],
  pulse: Array.from({ length: 12 }, (_, index) => ({
    weekStart: `2026-0${index < 4 ? 6 : index < 8 ? 7 : 8}-0${(index % 4) + 1}`,
    count: index,
  })),
};

/** A payload with every added panel empty, but the two loads still successful. */
const EMPTY_HOME: DashboardHome = {
  workspaceName: 'Acme Corp',
  continueProjects: [],
  attention: [],
  pulse: [],
};

/** A promise that never settles, for asserting the loading state. */
function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** Render, and wait for the three loads to land. */
async function renderLoaded(home: DashboardHome = HOME) {
  mockGetDashboardStats.mockResolvedValue(JSON.stringify(STATS));
  mockGetRecentActivity.mockResolvedValue(JSON.stringify(ACTIVITY));
  mockGetDashboardHome.mockResolvedValue(home);
  const result = render(<Dashboard />);
  await waitFor(() => {
    expect(screen.getByLabelText('Workspace statistics')).toBeInTheDocument();
  });
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  sessionUser.current = {
    user_id: 'user-1',
    name: 'Ada Lovelace',
    current_tenant_id: 'tenant-1',
  };
});

/* -------------------------------------------------------------------------
   1. Preserved exactly
   ------------------------------------------------------------------------- */

describe('Home — the widgets the redesign preserves', () => {
  it('draws the six stats with the subtitles the old strip showed', async () => {
    await renderLoaded();
    const strip = screen.getByLabelText('Workspace statistics');

    for (const label of ['Tenants', 'Projects', 'Versions', 'Published', 'Classes', 'Properties']) {
      expect(within(strip).getByText(label)).toBeInTheDocument();
    }
    expect(within(strip).getByText('2 admin')).toBeInTheDocument();
    expect(within(strip).getByText('9 drafts')).toBeInTheDocument();
    expect(within(strip).getByText('schema definitions')).toBeInTheDocument();
    expect(within(strip).getByText('962 in classes')).toBeInTheDocument();
    expect(within(strip).getByText('128')).toBeInTheDocument();
  });

  it('asks for ten activity rows and draws all of them', async () => {
    await renderLoaded();
    expect(mockGetRecentActivity).toHaveBeenCalledWith('user-1', 10);
    const panel = screen.getByRole('group', { name: 'Recent activity' });
    expect(within(panel).getAllByRole('listitem')).toHaveLength(10);
    expect(within(panel).getByText('Showing 10 actions')).toBeInTheDocument();
  });

  it('gives each row its verb, its tenant and a relative time with the absolute instant', async () => {
    await renderLoaded();
    const row = document.querySelector('[data-activity="version"]') as HTMLElement;

    expect(within(row).getByText('Created version', { exact: false })).toBeInTheDocument();
    expect(within(row).getByText(/Acme Corp|Globex Labs/)).toBeInTheDocument();

    const time = row.querySelector('time');
    expect(time).toHaveAttribute('dateTime');
    expect(time).toHaveAttribute('title');
    expect(time?.textContent).toMatch(/ago|just now/);
  });

  it('draws all four activity kinds with their own tone', async () => {
    await renderLoaded();
    const tones = new Set(
      Array.from(document.querySelectorAll('.home-row .home-tile')).map((tile) =>
        tile.getAttribute('data-tone'),
      ),
    );
    expect(tones).toEqual(new Set(['violet', 'ok', 'accent', 'warn']));
  });

  it('keeps the first-run checklist, and its documented dismiss key', async () => {
    await renderLoaded();
    // Every step is complete for this payload, so the checklist shows its finished heading.
    expect(screen.getByText("You're all set")).toBeInTheDocument();
    expect(screen.getByLabelText('Dismiss getting-started checklist')).toBeInTheDocument();
  });

  it('teaches instead of reciting zeroes when the activity list is empty', async () => {
    mockGetDashboardStats.mockResolvedValue(JSON.stringify(STATS));
    mockGetRecentActivity.mockResolvedValue('[]');
    mockGetDashboardHome.mockResolvedValue(EMPTY_HOME);
    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByText('No recent activity')).toBeInTheDocument();
    });
    expect(screen.getByText(/Start a project to see it here/)).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------
   Loading skeletons
   ------------------------------------------------------------------------- */

describe('Home — the loading state', () => {
  beforeEach(() => {
    mockGetDashboardStats.mockReturnValue(never<string>());
    mockGetRecentActivity.mockReturnValue(never<string>());
    mockGetDashboardHome.mockReturnValue(never<DashboardHome>());
  });

  it('draws six skeleton stats, shaped like the loaded strip', () => {
    render(<Dashboard />);
    const strip = screen.getByLabelText('Workspace statistics, loading');
    expect(strip.querySelectorAll('.hive-stat')).toHaveLength(6);
    expect(strip.querySelectorAll('.hive-skeleton').length).toBeGreaterThanOrEqual(18);
  });

  it('draws five skeleton activity rows', () => {
    render(<Dashboard />);
    expect(document.querySelectorAll('.home-rows .home-row').length).toBeGreaterThanOrEqual(5);
  });

  it('draws the continue cards as skeletons rather than as an empty state', () => {
    render(<Dashboard />);
    expect(document.querySelectorAll('.home-continue__card')).toHaveLength(3);
    expect(screen.queryByText('No projects yet')).not.toBeInTheDocument();
  });

  it('holds the checklist back until the counts arrive', () => {
    render(<Dashboard />);
    // Rendering it against zeroed stats would show five incomplete steps to a reader who has
    // finished them all, then correct itself.
    expect(screen.queryByLabelText('Dismiss getting-started checklist')).not.toBeInTheDocument();
  });

  it('has no serious or critical axe violations while loading', async () => {
    const { container } = render(<Dashboard />);
    const results = await axe(container);
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious).toEqual([]);
  });
});

/* -------------------------------------------------------------------------
   2. The added half — no empty grid regions
   ------------------------------------------------------------------------- */

describe('Home — what fills the half that used to be empty', () => {
  it('greets the reader by name and says what is moving', async () => {
    await renderLoaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Good (morning|afternoon|evening), Ada/);
    expect(screen.getByText(/3 projects, 14 versions, 5 published/)).toBeInTheDocument();
  });

  it('puts the workspace in the breadcrumb when the payload names one', async () => {
    await renderLoaded();
    const trail = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(trail).getByText('Acme Corp')).toBeInTheDocument();
    expect(within(trail).getByText('Home')).toBeInTheDocument();
  });

  it('omits the workspace step rather than inventing one', async () => {
    await renderLoaded({ ...HOME, workspaceName: null });
    const trail = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(within(trail).queryByText('Acme Corp')).not.toBeInTheDocument();
    expect(within(trail).getByText('Home')).toBeInTheDocument();
  });

  it('offers the two header actions through the shared open-action seam', async () => {
    await renderLoaded();
    // Scoped to the header: "Import a spec" is deliberately also a quick action, and both must
    // resolve to the same dialog rather than to two copies of the form.
    const header = within(screen.getByTestId('page-header'));
    expect(header.getByRole('link', { name: /Import a spec/ })).toHaveAttribute(
      'href',
      '/ade/dashboard/projects?open=import-spec',
    );
    expect(header.getByRole('link', { name: /New project/ })).toHaveAttribute(
      'href',
      '/ade/dashboard/projects?open=new-project',
    );
  });

  it('draws one continue card per project, each linking into that project versions', async () => {
    await renderLoaded();
    const cards = document.querySelectorAll('.home-continue__card');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveAttribute('href', '/ade/dashboard/versions?projectId=p-1');
    expect(within(cards[0] as HTMLElement).getByText('Payments API')).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText('Draft')).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText(/v2\.4\.0 · 18 classes · 42 properties/)).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByText(/^Edited /)).toBeInTheDocument();

    // The second card was published after its last edit, so the card says so — and its badge
    // says the lifecycle, which is a different statement about the same revision.
    const second = within(cards[1] as HTMLElement);
    expect(second.getByText(/^Published \d/)).toBeInTheDocument();
    expect(second.getByText('Published', { selector: '.home-continue__top *' })).toBeInTheDocument();
  });

  it('exposes each stored quality score as a meter rather than as colour alone', async () => {
    await renderLoaded();
    const ring = screen.getByRole('meter', { name: 'Quality score for Payments API' });
    expect(ring).toHaveAttribute('aria-valuenow', '88');
  });

  it('teaches the next step when there is no project to pick up', async () => {
    await renderLoaded(EMPTY_HOME);
    expect(screen.getByText('No projects yet')).toBeInTheDocument();
  });

  it('offers the five quick actions, all pointing at routes that exist', async () => {
    await renderLoaded();
    const panel = screen.getByRole('group', { name: 'Quick actions' });
    const links = within(panel).getAllByRole('link');
    expect(links).toHaveLength(5);
    for (const link of links) {
      expect(link.getAttribute('href')).toMatch(/^\/ade\/dashboard\//);
    }
  });

  it('withholds the workspace-scoped quick actions from a reader with no workspace', async () => {
    sessionUser.current = { user_id: 'user-1', name: 'Ada Lovelace' };
    await renderLoaded();
    const panel = screen.getByRole('group', { name: 'Quick actions' });
    const links = within(panel).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/ade/dashboard/catalog');
    // The header's own two actions are workspace-scoped as well.
    expect(screen.queryByRole('link', { name: /New project/ })).not.toBeInTheDocument();
  });

  it('draws the pulse, and states its total in words as well as in bars', async () => {
    await renderLoaded();
    expect(document.querySelectorAll('.home-bars__bar')).toHaveLength(12);
    // 0 + 1 + … + 11.
    expect(screen.getAllByText('66 versions published in the last 12 weeks').length).toBeGreaterThan(0);
  });

  it('leaves the pulse out when no window could be resolved', async () => {
    await renderLoaded(EMPTY_HOME);
    expect(document.querySelectorAll('.home-bars__bar')).toHaveLength(0);
  });

  it('fills both columns of the body, so neither is blank', async () => {
    await renderLoaded();
    const aside = screen.getByRole('complementary', { name: /Workspace shortcuts and health/i });
    // Quick actions, Needs attention and Publishing pulse.
    expect(aside.querySelectorAll(':scope > *')).toHaveLength(3);
    expect(aside.textContent?.trim()).not.toBe('');
  });
});

/* -------------------------------------------------------------------------
   3. Needs attention
   ------------------------------------------------------------------------- */

describe('Home — Needs attention', () => {
  it('lists each row, its consequence, and a link to a real route', async () => {
    await renderLoaded();
    const panel = screen.getByRole('group', { name: 'Needs attention' });
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);

    expect(within(panel).getByText('Orders Service v1.4.0 sunsets in 12 days')).toBeInTheDocument();
    expect(within(panel).getByText(/publish gate will fail/)).toBeInTheDocument();

    expect(within(panel).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      '/ade/dashboard/versions/sunset-timeline',
      '/ade/dashboard/lint-workspace',
      '/ade/dashboard/api-keys',
    ]);
  });

  it('counts the rows in its heading', async () => {
    await renderLoaded();
    const heading = screen.getByText('Needs attention').closest('.home-panel__title') as HTMLElement;
    expect(within(heading).getByText('3')).toBeInTheDocument();
  });

  it('is hidden entirely when nothing needs attention', async () => {
    await renderLoaded(EMPTY_HOME);
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('states the deadline in words, so urgency survives greyscale', async () => {
    await renderLoaded();
    const danger = document.querySelector('[data-attention="lint"]') as HTMLElement;
    expect(danger).toHaveAttribute('data-tone', 'danger');
    // The tone is on the row, but the row's own text is what carries the meaning.
    expect(danger.textContent).toContain('4 blocking lint findings');
  });
});

/* -------------------------------------------------------------------------
   4. Accessibility and resilience
   ------------------------------------------------------------------------- */

describe('Home — accessibility and resilience', () => {
  it('has no serious or critical axe violations when loaded', async () => {
    const { container } = await renderLoaded();
    const results = await axe(container);
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious).toEqual([]);
  });

  it('draws exactly one h1, and names every added region', async () => {
    await renderLoaded();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    for (const name of ['Pick up where you left off', 'Recent activity', 'Quick actions', 'Needs attention', 'Publishing pulse']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it('does not draw a second main landmark inside the shell one', async () => {
    const { container } = await renderLoaded();
    expect(container.querySelectorAll('main')).toHaveLength(0);
  });

  it('renders the shell of the page when every load fails', async () => {
    mockGetDashboardStats.mockRejectedValue(new Error('database is down'));
    mockGetRecentActivity.mockRejectedValue(new Error('database is down'));
    mockGetDashboardHome.mockRejectedValue(new Error('database is down'));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByLabelText('Workspace statistics')).toBeInTheDocument();
    });
    // Zeroed rather than blank, and the greeting still greets.
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
    errors.mockRestore();
  });

  it('survives a payload that is not the JSON it expects', async () => {
    mockGetDashboardStats.mockResolvedValue('not json at all');
    mockGetRecentActivity.mockResolvedValue('}{');
    mockGetDashboardHome.mockResolvedValue(EMPTY_HOME);

    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByLabelText('Workspace statistics')).toBeInTheDocument();
    });
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
  });

  it('rejects valid JSON of the wrong shape rather than letting it reach the render', async () => {
    // An object where the activity list belongs would reach `.map` and throw; an array where the
    // statistics belong would give every stat `undefined`.
    mockGetDashboardStats.mockResolvedValue('[1,2,3]');
    mockGetRecentActivity.mockResolvedValue('{"rows":[]}');
    mockGetDashboardHome.mockResolvedValue(EMPTY_HOME);

    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByLabelText('Workspace statistics')).toBeInTheDocument();
    });
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
    expect(screen.getByText(/Nothing here yet/)).toBeInTheDocument();
  });

  it('fills in a statistics column the server stopped sending, rather than printing undefined', async () => {
    mockGetDashboardStats.mockResolvedValue(JSON.stringify({ total_projects: 2, total_versions: 4 }));
    mockGetRecentActivity.mockResolvedValue('[]');
    mockGetDashboardHome.mockResolvedValue(EMPTY_HOME);

    render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getByLabelText('Workspace statistics')).toBeInTheDocument();
    });
    const strip = screen.getByLabelText('Workspace statistics');
    expect(within(strip).getByText('0 admin')).toBeInTheDocument();
    expect(strip.textContent).not.toContain('undefined');
    expect(strip.textContent).not.toContain('NaN');
  });

  it('loads nothing at all until the session names a user', () => {
    sessionUser.current = null;
    render(<Dashboard />);
    expect(mockGetDashboardStats).not.toHaveBeenCalled();
    expect(mockGetDashboardHome).not.toHaveBeenCalled();
  });
});
