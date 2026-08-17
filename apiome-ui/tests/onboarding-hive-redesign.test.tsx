/**
 * The first-tenant onboarding wizard's Hive skin (HIVE-4.4, #5298).
 *
 * `tests/first-tenant-onboarding-wizard.test.tsx` owns the *flow* — step order, resume,
 * funnel events, provisioning — and none of that moved. This suite owns what the ticket
 * actually changed:
 *
 *   1. The wizard draws the shared `AuthShell`, not a page of named greys, and it says
 *      who is signed in.
 *   2. The progress header is the shared `ui/Stepper`, and it announces the reader's
 *      position — including the terminal step, where every marker is done.
 *   3. The organization step is the shared `AuthField` + `SlugField` pair (HIVE-4.3),
 *      and every sentence the four availability states carry is word for word the one
 *      the wizard already carried.
 *   4. The review and done steps draw the mockup's plan card and success tile.
 *   5. No named colour survives anywhere in the directory.
 */
import React from 'react';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const mockUpdate = jest.fn<Promise<unknown>, [unknown]>(async () => null);
const mockPush = jest.fn();
const mockRefresh = jest.fn();
const mockSignOutEverywhere = jest.fn();
const mockProvisionFirstTenant = jest.fn<Promise<unknown>, [string, string]>();
const mockCheckSlugAvailability = jest.fn<Promise<{ status: string }>, [string]>();
const mockLoadState = jest.fn<Promise<unknown>, []>();

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => ({
    data: { user: { email: 'ada@example.com' } },
    status: 'authenticated',
    update: mockUpdate,
  }),
  AuthSessionProvider: ({ children }: { children: unknown }) => children,
  signIn: jest.fn(),
  signOut: jest.fn(),
}));

jest.mock('@lib/auth/sign-out-client', () => ({
  signOutEverywhere: (...args: unknown[]) => mockSignOutEverywhere(...args),
}));

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, refresh: mockRefresh }),
}));

jest.mock('@lib/auth/first-tenant-actions', () => ({
  provisionFirstTenant: (name: string, slug: string) => mockProvisionFirstTenant(name, slug),
}));

jest.mock('@lib/auth/tenant-slug-availability', () => ({
  checkTenantSlugAvailability: (slug: string) => mockCheckSlugAvailability(slug),
}));

jest.mock('@lib/auth/onboarding-wizard-state-actions', () => ({
  loadOnboardingWizardState: () => mockLoadState(),
  saveOnboardingWizardStep: jest.fn(async () => undefined),
  completeOnboardingWizard: jest.fn(async () => undefined),
}));

import FirstTenantOnboardingWizard from '@/app/components/auth/onboarding/FirstTenantOnboardingWizard';
import { SLUG_CHECK_DEBOUNCE_MS } from '@/app/components/auth/onboarding/OrganizationStep';
import { FREE_LICENSE_SUMMARY } from '@lib/auth/free-license';

/** The directory this ticket re-skinned, for the source sweep at the foot of the file. */
const ONBOARDING_DIR = join(
  __dirname,
  '..',
  'src',
  'app',
  'components',
  'auth',
  'onboarding'
);

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckSlugAvailability.mockResolvedValue({ status: 'available' });
  mockLoadState.mockResolvedValue(null);
  mockProvisionFirstTenant.mockResolvedValue({
    success: true,
    tenant: { id: 't-1', name: 'Acme Corp', slug: 'acme-corp' },
  });
});

const nameInput = () => screen.getByPlaceholderText('Acme, Inc.');
const slugInput = () => screen.getByPlaceholderText('acme-inc');

/** Walks welcome → organization and enters `name` (the slug follows it). */
const openOrganizationStep = (name = 'Acme Corp') => {
  fireEvent.click(screen.getByRole('button', { name: /set up your organization/i }));
  fireEvent.change(nameInput(), { target: { value: name } });
};

/** Runs the debounce and flushes the probe promise. Requires fake timers. */
const flushProbe = async () => {
  await act(async () => {
    jest.advanceTimersByTime(SLUG_CHECK_DEBOUNCE_MS);
  });
};

// =========================================================================================
// The frame
// =========================================================================================

describe('onboarding wizard — the shared shell', () => {
  it('draws the hex canvas and the centred, widened card column', () => {
    const { container } = render(<FirstTenantOnboardingWizard />);

    expect(container.querySelector('.auth-shell.hex-bg')).toBeInTheDocument();
    expect(container.querySelector('main.auth-center')).toBeInTheDocument();
    // A wizard carries a progress row and a two-column review, so it is wider than the
    // 27.5 rem the sign-in card gets.
    expect(container.querySelector('.auth-form__inner--wide')).toBeInTheDocument();
    expect(container.querySelector('.wiz-card')).toBeInTheDocument();
  });

  it('names who is signed in, so the page does not read as a sign-in screen', () => {
    render(<FirstTenantOnboardingWizard />);

    expect(screen.getByTestId('onboarding-signed-in-as')).toHaveTextContent(
      'Signed in as ada@example.com'
    );
  });

  it('draws the top row as a banner landmark above the page’s single `main`', () => {
    const { container } = render(<FirstTenantOnboardingWizard />);

    const header = container.querySelector('header.auth-topbar');
    expect(header).toBeInTheDocument();
    expect(container.querySelectorAll('main')).toHaveLength(1);
    // The top row is a sibling of `main`, not inside it — otherwise it would be part of
    // the wizard's own content rather than the page's chrome.
    expect(header?.nextElementSibling?.tagName).toBe('MAIN');
  });

  it('tells the reader their progress survives leaving', () => {
    render(<FirstTenantOnboardingWizard />);

    expect(screen.getByText(/progress is saved server-side/i)).toBeInTheDocument();
  });

  it('is not a dialog: there is nothing behind it to be modal over', () => {
    // The mockup marks the card `role="dialog" aria-modal="true"`. The guard renders this
    // *instead of* the route, so a modal role would promise a surface underneath that
    // does not exist — and no focus trap could be honest about restoring focus to it.
    const { container } = render(<FirstTenantOnboardingWizard />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.querySelector('[aria-modal]')).toBeNull();
  });
});

// =========================================================================================
// The progress row
// =========================================================================================

describe('onboarding wizard — the shared Stepper', () => {
  it('replaces the bespoke `<ol>` with the primitive, filled across the band', () => {
    const { container } = render(<FirstTenantOnboardingWizard />);

    const stepper = container.querySelector('.wiz-card__progress > ol.stepper');
    expect(stepper).toHaveClass('stepper--fill');
    expect(stepper).toHaveAccessibleName('Setup progress');
  });

  it('announces the current step, and moves the marker as the reader advances', async () => {
    render(<FirstTenantOnboardingWizard />);

    const list = screen.getByRole('list', { name: 'Setup progress' });
    expect(within(list).getByText('Step 1 of 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /set up your organization/i }));
    await waitFor(() => expect(within(list).getByText('Step 2 of 3')).toBeInTheDocument());
    expect(
      within(list).getAllByRole('listitem').filter((item) => item.dataset.status === 'done')
    ).toHaveLength(1);
  });

  it('marks every step done once the tenant exists', async () => {
    render(<FirstTenantOnboardingWizard />);

    openOrganizationStep();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(await screen.findByRole('button', { name: /create organization/i }));
    await screen.findByTestId('onboarding-step-done');

    const items = within(screen.getByRole('list', { name: 'Setup progress' })).getAllByRole(
      'listitem'
    );
    expect(items.map((item) => item.dataset.status)).toEqual(['done', 'done', 'done']);
    expect(items.some((item) => item.hasAttribute('aria-current'))).toBe(false);
  });
});

// =========================================================================================
// Welcome
// =========================================================================================

describe('onboarding wizard — the welcome step', () => {
  it('leads with the honey hexagon, not a gradient tile of named indigo', () => {
    const { container } = render(<FirstTenantOnboardingWizard />);

    const tile = container.querySelector('.auth-icon.auth-icon--honey');
    expect(tile).toBeInTheDocument();
    expect(tile).toHaveAttribute('aria-hidden', 'true');
  });

  it('sets the invitation line as a note rather than an alert', () => {
    // Nothing has gone wrong — this is the way out for someone who is here by mistake.
    render(<FirstTenantOnboardingWizard />);

    expect(screen.getByRole('note')).toHaveTextContent(
      'Expecting an invitation? Once a tenant administrator adds you, check again to continue.'
    );
  });

  it('puts its three actions in the card’s action band', () => {
    const { container } = render(<FirstTenantOnboardingWizard />);

    const foot = container.querySelector('.wiz-card__foot');
    expect(within(foot as HTMLElement).getByRole('button', { name: /check again/i })).toBeInTheDocument();
    expect(within(foot as HTMLElement).getByTestId('onboarding-sign-out')).toBeInTheDocument();
    expect(
      within(foot as HTMLElement).getByRole('button', { name: /set up your organization/i })
    ).toBeInTheDocument();
  });
});

// =========================================================================================
// Organization
// =========================================================================================

describe('onboarding wizard — the organization step reuses the 4.3 slug field', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('ties both labels to their controls, which `FormField` never did', () => {
    render(<FirstTenantOnboardingWizard />);
    openOrganizationStep();

    expect(screen.getByLabelText(/organization name/i)).toBe(nameInput());
    expect(screen.getByLabelText('URL slug')).toBe(slugInput());
  });

  it('marks the name required without letting the browser pre-empt the message', () => {
    // A native `required` makes the browser refuse the submit, and "Organization name is
    // required" — the message that says *which* field to fix — would never be reached.
    render(<FirstTenantOnboardingWizard />);
    openOrganizationStep('');

    expect(nameInput()).toHaveAttribute('aria-required', 'true');
    // No native `required` attribute — that, not `aria-required`, is what the browser's
    // own constraint validation gates the submit on.
    expect(nameInput()).not.toHaveAttribute('required');
    expect(slugInput()).not.toHaveAttribute('required');

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('Organization name is required')).toBeInTheDocument();
  });

  it('draws the chip inside the box and speaks the sentence beside it', async () => {
    render(<FirstTenantOnboardingWizard />);
    openOrganizationStep();
    await flushProbe();

    // Two readouts of one fact: two words a sighted reader can take in beside their own
    // typing, and the full sentence for a screen reader.
    expect(screen.getByTestId('slug-availability-chip')).toHaveTextContent('Available');
    expect(screen.getByTestId('slug-availability-chip')).toHaveAttribute('aria-hidden', 'true');

    const announcement = screen.getByTestId('slug-availability');
    expect(announcement).toHaveAttribute('role', 'status');
    expect(announcement).toHaveTextContent('"acme-corp" is available');
  });

  it('keeps every one of the four availability sentences word for word', async () => {
    const cases: ReadonlyArray<[string, string, string]> = [
      ['available', 'Available', '"acme-corp" is available'],
      ['taken', 'Taken', '"acme-corp" is already taken'],
      ['unknown', 'Unverified', 'Could not verify availability — you can still continue'],
    ];

    for (const [status, chip, sentence] of cases) {
      mockCheckSlugAvailability.mockResolvedValue({ status });
      const { unmount } = render(<FirstTenantOnboardingWizard />);
      openOrganizationStep();

      // Before the debounce lands, the field is still asking.
      expect(screen.getByTestId('slug-availability')).toHaveTextContent('Checking availability…');
      await flushProbe();

      expect(screen.getByTestId('slug-availability-chip')).toHaveTextContent(chip);
      expect(screen.getByTestId('slug-availability')).toHaveTextContent(sentence);
      unmount();
    }
  });

  it('keeps the rule under the field while an error is showing — they say different things', () => {
    render(<FirstTenantOnboardingWizard />);
    openOrganizationStep();
    fireEvent.change(slugInput(), { target: { value: 'no spaces!' } });

    expect(
      screen.getByText('Lowercase letters, numbers, and dashes. Suggested from the name — edit it if you like.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Slug must contain only lowercase letters, numbers, and dashes')
    ).toBeInTheDocument();
    expect(slugInput()).toHaveAttribute('aria-invalid', 'true');
  });
});

// =========================================================================================
// Review
// =========================================================================================

describe('onboarding wizard — the review step', () => {
  /** Reaches the review step with `Acme Corp` / `acme-corp` entered. */
  const openReview = async () => {
    render(<FirstTenantOnboardingWizard />);
    openOrganizationStep();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    return screen.findByTestId('onboarding-step-summary');
  };

  it('lists the two values as a description list, the slug in the identifier face', async () => {
    const body = await openReview();

    const list = body.querySelector('dl.wiz-kv') as HTMLElement;
    expect(within(list).getByText('Organization')).toBeInTheDocument();
    expect(within(list).getByText('Acme Corp')).toBeInTheDocument();
    // `.mono` is the identifier face, and it follows the reader's `mono-ids` preference.
    expect(within(list).getByText('acme-corp')).toHaveClass('mono');
  });

  it('draws the plan’s quotas as the mockup’s three cells, from the one constant', async () => {
    await openReview();

    const plan = screen.getByTestId('free-license-summary');
    expect(plan).toHaveAttribute('role', 'region');
    expect(plan).toHaveAccessibleName(`${FREE_LICENSE_SUMMARY.planName} plan summary`);
    expect(plan).toHaveTextContent('No payment details');

    // Each quota is one cell holding its own label/value pair, so the two `1`s the plan
    // grants stay attached to the right names.
    const cells = Array.from(plan.querySelectorAll('dl.wiz-limits > div'));
    expect(cells).toHaveLength(FREE_LICENSE_SUMMARY.limits.length);
    FREE_LICENSE_SUMMARY.limits.forEach((limit, index) => {
      expect(cells[index].querySelector('dt')).toHaveTextContent(limit.label);
      expect(cells[index].querySelector('dd')).toHaveTextContent(limit.value);
    });
    for (const item of FREE_LICENSE_SUMMARY.includes) {
      expect(plan).toHaveTextContent(item);
    }
  });

  it('interrupts with a provisioning failure rather than leaving it to be found', async () => {
    mockProvisionFirstTenant.mockResolvedValue({ success: false, error: 'Slug already exists' });
    await openReview();

    fireEvent.click(screen.getByRole('button', { name: /create organization/i }));

    const alert = await screen.findByTestId('onboarding-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Slug already exists');
  });
});

// =========================================================================================
// Done
// =========================================================================================

describe('onboarding wizard — the done step', () => {
  /** Provisions the tenant and lands on the terminal step. */
  const openDone = async () => {
    render(<FirstTenantOnboardingWizard />);
    openOrganizationStep();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    fireEvent.click(await screen.findByRole('button', { name: /create organization/i }));
    return screen.findByTestId('onboarding-step-done');
  };

  it('draws the shared honeycomb art rather than a second copy of one', async () => {
    const body = await openDone();

    const art = body.querySelector('.hive-empty-art');
    expect(art).toBeInTheDocument();
    expect(art).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows the tenant the way the rail will: hex avatar, name, role and plan', async () => {
    const body = await openDone();

    expect(within(body).getByRole('heading', { name: 'Acme Corp is ready' })).toBeInTheDocument();
    const avatar = body.querySelector('.avatar-hex');
    expect(avatar).toBeInTheDocument();
    // Decorative: the name is written beside it.
    expect(avatar).toHaveAttribute('aria-hidden', 'true');
    expect(within(body).getByText('Owner')).toBeInTheDocument();
    expect(within(body).getByText('Free')).toBeInTheDocument();
  });

  it('centres its single action', async () => {
    await openDone();

    const foot = document.querySelector('.wiz-card__foot') as HTMLElement;
    expect(foot).toHaveClass('wiz-card__foot--center');
    expect(within(foot).getByRole('button', { name: /go to your dashboard/i })).toBeInTheDocument();
  });
});

// =========================================================================================
// The sweep
// =========================================================================================

describe('onboarding wizard — no named colour survives', () => {
  /** Every source file the ticket re-skinned. */
  const files = readdirSync(ONBOARDING_DIR).filter((entry) => entry.endsWith('.tsx'));

  it('finds the four steps and the shell to scan', () => {
    expect(files.sort()).toEqual([
      'DoneStep.tsx',
      'FirstTenantOnboardingWizard.tsx',
      'OrganizationStep.tsx',
      'SummaryStep.tsx',
      'WelcomeStep.tsx',
    ]);
  });

  it('names no Tailwind palette colour anywhere in the directory', () => {
    // The whole point of the ticket: a wizard painted in `gray-900` / `indigo-600` /
    // `emerald-100` follows no theme the reader can choose. Every colour is a role token.
    const palette =
      /\b(?:bg|text|border|from|to|via|ring|fill|stroke|shadow)-(?:gray|slate|zinc|neutral-\d|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet-\d|purple|fuchsia|pink|rose-\d|white|black)\b/;
    const offenders: string[] = [];

    for (const file of files) {
      readFileSync(join(ONBOARDING_DIR, file), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const match = palette.exec(line);
          if (match) offenders.push(`${file}:${index + 1}  ${match[0]}`);
        });
    }

    expect(offenders).toEqual([]);
  });
});
