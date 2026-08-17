/**
 * The OAuth sign-up completion card (HIVE-4.3, #5297).
 *
 * The re-skin moved none of the flow, so this suite pins both halves at once — what the
 * screen has always done, and what the ticket added:
 *
 *   1. The card is drawn in the shared `AuthShell` in its centred shape, with the lock-up
 *      above it, one `<main>` and one `<h1>` — no page-local stylesheet, no named colour.
 *   2. Every string the mockup's "Keeps (1:1)" list names is still on the page, including
 *      the Free-plan sentence word for word.
 *   3. The slug follows the organization name until it is hand-edited, clearing it puts
 *      the suggestion back, and the field is lowercase whatever is typed into it.
 *   4. All four availability states are reachable, the chip and the announcement agree,
 *      and only `taken` blocks submission — `unknown` fails open.
 *   5. Submitting still runs `completeOAuthSignup` → one-time-code credentials sign-in,
 *      and a rejected sign-up still says what the server said.
 */
import React from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SLUG_CHECK_DEBOUNCE_MS, type SlugAvailabilityResult } from '@lib/auth/slug-availability';

const mockCompleteOAuthSignup = jest.fn();
const mockCheckSlug = jest.fn<Promise<SlugAvailabilityResult>, [string, string]>();
const mockSignIn = jest.fn();

jest.mock('@lib/auth/oauth-signup-actions', () => ({
  completeOAuthSignup: (...args: unknown[]) => mockCompleteOAuthSignup(...args),
  checkOauthSignupSlugAvailability: (token: string, slug: string) => mockCheckSlug(token, slug),
}));

jest.mock('@lib/auth/session-client', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

import OauthSignupClient from '@/app/signup/oauth/OauthSignupClient';

/** The client's source, for the assertions that read it rather than render it. */
const CLIENT_SOURCE = readFileSync(
  join(__dirname, '..', 'src', 'app', 'signup', 'oauth', 'OauthSignupClient.tsx'),
  'utf8'
);

/** The token the page proved before rendering the card. */
const TOKEN = 'pending-1';

/**
 * Render the card.
 *
 * @param provider Provider id the reader arrived from. Pass `undefined` explicitly for a
 *   page that could not name one — the "via …" clause then goes.
 * @returns Testing Library's render result.
 */
function renderCard(provider?: string) {
  return render(
    <OauthSignupClient token={TOKEN} emailHint="a***a@example.com" provider={provider} />
  );
}

/**
 * A user-event instance wired to jest's fake timers, so the debounce can be advanced by
 * hand without `userEvent` waiting on the real clock.
 *
 * @returns The instance.
 */
const setupUser = () =>
  userEvent.setup({ advanceTimers: jest.advanceTimersByTime.bind(jest) });

/**
 * Let the debounce elapse, the probe's promise settle and React commit the verdict.
 *
 * `act` around the clock advance is what makes the third of those happen: without it the
 * request has been made but the state it produces has not landed, and a submit right after
 * would find no verdict to reuse.
 */
async function settleProbe() {
  await act(async () => {
    jest.advanceTimersByTime(SLUG_CHECK_DEBOUNCE_MS);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  mockCheckSlug.mockResolvedValue({ status: 'available' });
  mockCompleteOAuthSignup.mockResolvedValue({ success: true, oneTimeCode: 'code-1' });
  mockSignIn.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('OAuth sign-up — the frame', () => {
  it('draws the card in the shared centred auth shell', () => {
    const { container } = renderCard('github');

    // The centred shape: the hex canvas, one `<main>`, and no brand panel — the same
    // frame `/login/2fa` uses, which is why neither screen carries a stylesheet.
    expect(container.querySelector('.auth-shell.hex-bg')).not.toBeNull();
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(container.querySelector('main')).toHaveClass('auth-center');
    expect(container.querySelector('.auth-brand')).toBeNull();
    expect(screen.getByTestId('oauth-signup-card')).toHaveClass('auth-card');
  });

  it('names the product once, above the card', () => {
    const { container } = renderCard('github');

    expect(container.querySelectorAll('.auth-brandbar')).toHaveLength(1);
    expect(container.querySelector('.auth-brandbar .brand-lockup')).not.toBeNull();
  });

  it('gives the page exactly one heading, and it is the card’s', () => {
    renderCard('github');

    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent('Finish setting up your account');
  });

  it('imports no CSS module and names no colour', () => {
    // The gradient card of named indigo/purple/slate is what this ticket removed; a
    // colour written here again could not follow the reader's theme.
    expect(CLIENT_SOURCE).not.toMatch(/\.module\.css/);
    expect(CLIENT_SOURCE).not.toMatch(
      /\b(?:bg|text|border|from|via|to|ring|shadow)-(?:slate|gray|indigo|purple|emerald|red|white|black)\b/
    );
  });
});

describe('OAuth sign-up — what the card says', () => {
  it('keeps the masked email and adds the provider it came from', () => {
    const identity = screen.getByTestId.bind(screen);
    renderCard('github');

    expect(identity('oauth-signup-identity')).toHaveTextContent(
      'Signed in as a***a@example.com via GitHub'
    );
  });

  it('drops the provider clause when the page could not name one', () => {
    renderCard();

    expect(screen.getByTestId('oauth-signup-identity')).toHaveTextContent(
      'Signed in as a***a@example.com'
    );
    expect(screen.getByTestId('oauth-signup-identity')).not.toHaveTextContent('via');
  });

  it('keeps the Free-plan copy word for word', () => {
    renderCard('github');

    const plan = screen.getByTestId('oauth-signup-plan');
    expect(plan).toHaveTextContent(
      'Free plan — Includes 1 organization, 1 project, and up to 3 versions. You can upgrade anytime.'
    );
    // A note, not an alert: it is standing information about the account being made.
    expect(plan).toHaveAttribute('role', 'note');
  });

  it('labels all three fields, and links each label to its control', () => {
    renderCard('github');

    expect(screen.getByLabelText('Your name')).toHaveAttribute('id', 'displayName');
    expect(screen.getByLabelText('Organization name')).toHaveAttribute('id', 'orgName');
    expect(screen.getByLabelText('Organization URL slug')).toHaveAttribute('id', 'slug');
  });

  it('keeps the slug rule and the way back to sign in', () => {
    renderCard('github');

    expect(
      screen.getByText(
        'Lowercase letters, numbers, and dashes only. Used in API paths for your organization.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute('href', '/login');
  });
});

describe('OAuth sign-up — the slug follows the organization name', () => {
  it('derives the slug from the name until the slug is hand-edited', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization name'), 'Acme Design');
    expect(screen.getByLabelText('Organization URL slug')).toHaveValue('acme-design');

    await user.clear(screen.getByLabelText('Organization URL slug'));
    await user.type(screen.getByLabelText('Organization URL slug'), 'acme-eu');
    await user.type(screen.getByLabelText('Organization name'), ' Ltd');

    // The name moved on; the hand-typed slug did not.
    expect(screen.getByLabelText('Organization URL slug')).toHaveValue('acme-eu');
  });

  it('puts the suggestion back once the slug is cleared', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization name'), 'Acme');
    await user.clear(screen.getByLabelText('Organization URL slug'));
    await user.type(screen.getByLabelText('Organization URL slug'), 'x');
    await user.clear(screen.getByLabelText('Organization URL slug'));

    await user.type(screen.getByLabelText('Organization name'), ' Design');
    expect(screen.getByLabelText('Organization URL slug')).toHaveValue('acme-design');
  });

  it('forces the slug lowercase as it is typed', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization URL slug'), 'ACME-Corp');

    // Lowercased in state, not merely drawn that way: the column stores lowercase, so the
    // field must never show something the server will silently change.
    expect(screen.getByLabelText('Organization URL slug')).toHaveValue('acme-corp');
  });

  it('previews the URL the organization will live at', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization URL slug'), 'acme-corp');

    expect(screen.getByTestId('slug-preview')).toHaveTextContent('acme-corp');
    expect(screen.getByTestId('slug-preview')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('OAuth sign-up — live availability', () => {
  it('says nothing at all until the slug could be one', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization URL slug'), 'a');
    await settleProbe();

    // One character fails `validateTenantSlug`, so there is nothing to ask about — the
    // shape error under the field is the message, not a verdict on availability.
    expect(mockCheckSlug).not.toHaveBeenCalled();
    expect(screen.queryByTestId('slug-availability-chip')).toBeNull();
  });

  it('shows checking, then the verdict, for a well-shaped slug', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization URL slug'), 'acme-corp');
    expect(screen.getByTestId('slug-availability-chip')).toHaveTextContent('Checking');
    expect(screen.getByTestId('slug-availability')).toHaveTextContent('Checking availability…');

    await settleProbe();

    await waitFor(() =>
      expect(screen.getByTestId('slug-availability-chip')).toHaveTextContent('Available')
    );
    expect(screen.getByTestId('slug-availability')).toHaveTextContent('"acme-corp" is available');
    expect(mockCheckSlug).toHaveBeenCalledWith(TOKEN, 'acme-corp');
  });

  it('asks once for a slug typed in one go', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization URL slug'), 'acme-corp');
    await settleProbe();

    // The debounce is the point: nine keystrokes, one request.
    await waitFor(() => expect(mockCheckSlug).toHaveBeenCalledTimes(1));
  });

  it('marks a slug another organization holds as taken', async () => {
    mockCheckSlug.mockResolvedValue({ status: 'taken' });
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization URL slug'), 'acme');
    await settleProbe();

    await waitFor(() =>
      expect(screen.getByTestId('slug-availability-chip')).toHaveTextContent('Taken')
    );
    expect(screen.getByTestId('slug-availability')).toHaveTextContent('"acme" is already taken');
  });

  it('says so, and stays out of the way, when it cannot check', async () => {
    mockCheckSlug.mockResolvedValue({ status: 'unknown' });
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization URL slug'), 'acme');
    await settleProbe();

    await waitFor(() =>
      expect(screen.getByTestId('slug-availability-chip')).toHaveTextContent('Unverified')
    );
    expect(screen.getByTestId('slug-availability')).toHaveTextContent(
      'Could not verify availability — you can still continue'
    );
  });

  it('never lets a slow answer about an older slug land on the current one', async () => {
    // The reader keeps typing while a request is out. The verdict is tagged with the slug
    // it is about, so `acm`'s answer is simply never `acme`'s.
    const pending = new Map<string, (result: SlugAvailabilityResult) => void>();
    mockCheckSlug.mockImplementation(
      (_token, slug) => new Promise((resolve) => pending.set(slug, resolve))
    );
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization URL slug'), 'acm');
    await settleProbe();
    await user.type(screen.getByLabelText('Organization URL slug'), 'e');
    await settleProbe();

    await act(async () => {
      pending.get('acm')!({ status: 'taken' });
    });
    expect(screen.getByTestId('slug-availability-chip')).toHaveTextContent('Checking');

    await act(async () => {
      pending.get('acme')!({ status: 'available' });
    });
    expect(screen.getByTestId('slug-availability-chip')).toHaveTextContent('Available');
  });

  it('hides the chip from assistive technology and announces the sentence instead', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Organization URL slug'), 'acme-corp');

    // The same information twice would be read twice; the chip is the sighted half.
    expect(screen.getByTestId('slug-availability-chip')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('slug-availability')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('slug-availability')).toHaveClass('sr-only');
  });
});

describe('OAuth sign-up — creating the account', () => {
  /**
   * Fill the card in, ready to submit.
   *
   * @param user The user-event instance.
   * @param slug The slug to type; omitted leaves the name-derived one.
   */
  async function fillForm(user: ReturnType<typeof setupUser>, slug?: string) {
    await user.type(screen.getByLabelText('Your name'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Organization name'), 'Acme Corp');
    if (slug !== undefined) {
      await user.clear(screen.getByLabelText('Organization URL slug'));
      await user.type(screen.getByLabelText('Organization URL slug'), slug);
    }
  }

  it('provisions, then signs in with the one-time code', async () => {
    const user = setupUser();
    renderCard('github');

    await fillForm(user);
    await settleProbe();
    await user.click(screen.getByTestId('oauth-signup-submit'));

    await waitFor(() =>
      expect(mockCompleteOAuthSignup).toHaveBeenCalledWith(
        TOKEN,
        'Ada Lovelace',
        'Acme Corp',
        'acme-corp'
      )
    );
    expect(mockSignIn).toHaveBeenCalledWith('credentials', {
      payload: JSON.stringify({ oneTimeCode: 'code-1' }),
      callbackUrl: '/ade',
      redirect: true,
    });
  });

  it('does not submit while a required field is empty', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Your name'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Organization name'), 'Acme Corp');
    await user.clear(screen.getByLabelText('Organization URL slug'));
    await settleProbe();
    await user.click(screen.getByTestId('oauth-signup-submit'));

    // All three fields are `required`, so the browser refuses the submit before any of
    // this screen's own validation runs — nothing is probed and nothing is created.
    expect(mockCheckSlug).not.toHaveBeenCalled();
    expect(mockCompleteOAuthSignup).not.toHaveBeenCalled();
    for (const label of ['Your name', 'Organization name', 'Organization URL slug']) {
      expect(screen.getByLabelText(label)).toBeRequired();
    }
  });

  it('reuses a verdict it already has rather than probing again', async () => {
    const user = setupUser();
    renderCard('github');

    await fillForm(user);
    await settleProbe();
    await waitFor(() => expect(mockCheckSlug).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId('oauth-signup-submit'));

    await waitFor(() => expect(mockCompleteOAuthSignup).toHaveBeenCalled());
    expect(mockCheckSlug).toHaveBeenCalledTimes(1);
  });

  it('stops at a taken slug before creating anything', async () => {
    mockCheckSlug.mockResolvedValue({ status: 'taken' });
    const user = setupUser();
    renderCard('github');

    await fillForm(user);
    await settleProbe();
    await user.click(screen.getByTestId('oauth-signup-submit'));

    await waitFor(() =>
      expect(
        screen.getByText('This slug is already taken — please choose another')
      ).toBeInTheDocument()
    );
    expect(mockCompleteOAuthSignup).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Organization URL slug')).toHaveAttribute('aria-invalid', 'true');
  });

  it('lets an unverifiable slug through — the server has the last word', async () => {
    mockCheckSlug.mockResolvedValue({ status: 'unknown' });
    const user = setupUser();
    renderCard('github');

    await fillForm(user);
    await settleProbe();
    await user.click(screen.getByTestId('oauth-signup-submit'));

    await waitFor(() => expect(mockCompleteOAuthSignup).toHaveBeenCalled());
  });

  it('shows the server’s own sentence when the sign-up is rejected', async () => {
    mockCompleteOAuthSignup.mockResolvedValue({
      success: false,
      error: 'A tenant with this slug already exists',
    });
    const user = setupUser();
    renderCard('github');

    await fillForm(user);
    await settleProbe();
    await user.click(screen.getByTestId('oauth-signup-submit'));

    const banner = await screen.findByTestId('oauth-signup-error');
    expect(banner).toHaveTextContent('A tenant with this slug already exists');
    expect(banner).toHaveAttribute('role', 'alert');
    // The form comes back: the reader has to be able to fix what was rejected.
    expect(screen.getByTestId('oauth-signup-submit')).toBeEnabled();
  });

  it('falls back to one sentence when the action throws', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockCompleteOAuthSignup.mockRejectedValue(new Error('boom'));
    const user = setupUser();
    renderCard('github');

    await fillForm(user);
    await settleProbe();
    await user.click(screen.getByTestId('oauth-signup-submit'));

    expect(await screen.findByTestId('oauth-signup-error')).toHaveTextContent(
      'Something went wrong. Please try again.'
    );
    consoleError.mockRestore();
  });

  it('locks the card down while the workspace is being created', async () => {
    let release: (value: { success: false; error: string }) => void = () => {};
    mockCompleteOAuthSignup.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const user = setupUser();
    renderCard('github');

    await fillForm(user);
    await settleProbe();
    await user.click(screen.getByTestId('oauth-signup-submit'));

    const submit = await screen.findByTestId('oauth-signup-submit');
    await waitFor(() => expect(submit).toBeDisabled());
    expect(submit).toHaveTextContent('Creating your workspace…');
    for (const label of ['Your name', 'Organization name', 'Organization URL slug']) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }

    release({ success: false, error: 'nope' });
    await waitFor(() => expect(screen.getByTestId('oauth-signup-submit')).toBeEnabled());
  });

  it('refuses a slug that could never be one, without asking the server', async () => {
    const user = setupUser();
    renderCard('github');

    await user.type(screen.getByLabelText('Your name'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Organization name'), 'Acme Corp');
    await user.clear(screen.getByLabelText('Organization URL slug'));
    await user.type(screen.getByLabelText('Organization URL slug'), 'a');
    await settleProbe();
    await user.click(screen.getByTestId('oauth-signup-submit'));

    const field = screen.getByLabelText('Organization URL slug');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(
      within(screen.getByTestId('oauth-signup-card')).getByText(/at least 2 characters/i)
    ).toBeInTheDocument();
    expect(mockCompleteOAuthSignup).not.toHaveBeenCalled();
  });
});
