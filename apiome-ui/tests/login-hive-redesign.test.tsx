/**
 * The markup half of the sign-in / create-account redesign (HIVE-4.1, #5295).
 *
 * The information architecture was deliberately left alone, and the suites that pin it —
 * `login-provider-buttons`, `login-credentials-collapse`, `login-error-rendering`,
 * `login-a11y` — still pass unchanged. This suite pins what the re-skin *added*, so a later
 * ticket cannot quietly undo it:
 *
 *   1. The page is drawn in the shared `AuthShell`: one `<main>`, a hex canvas, a brand
 *      panel beside the card, and a single mark at every viewport width.
 *   2. The bee is on the page twice in the DOM and once on screen — the brand panel's
 *      lock-up and the card's own glyph, swapped by CSS at 1000 px.
 *   3. The format chips come from the catalog format registry, so they carry the same hues
 *      the rest of the app gives those formats, and they are ornament to a screen reader.
 *   4. The banner is the Hive `Alert` in the tone its severity maps to, still announcing
 *      through `role="alert"` / `role="status"` and still offering "Try again" as a link.
 *   5. The BETA watermark became a honey badge behind the same env flag.
 *   6. A rejected credentials pair is marked on the fields, and stops being marked as soon
 *      as the reader starts fixing it.
 *   7. Nothing on the page names a colour: no palette utilities, no aurora module.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockSignIn = jest.fn();

jest.mock('@lib/auth/session-client', () => ({
  AuthSessionProvider: ({ children }: { children: unknown }) => children,
  signOut: jest.fn(),
  signIn: (...args: unknown[]) => mockSignIn(...args),
}));

jest.mock('../lib/db/helper', () => ({
  createSignupRequest: jest.fn(),
}));

import LoginClient from '../src/app/login/LoginClient';
import { AuthShell } from '../src/app/components/auth/AuthShell';
import { BetaBadge } from '../src/app/components/auth/BetaBadge';
import type { ProviderSummary } from '../lib/auth/provider-registry';

const summary = (id: string, label: string): ProviderSummary => ({
  id,
  label,
  status: 'available',
  enabled: true,
});

const PROVIDERS = [summary('github', 'GitHub'), summary('gitlab', 'GitLab')];

/** The eight formats the brand panel floats, in the mockup's order. */
const FORMAT_CHIP_LABELS = [
  'OpenAPI',
  'AsyncAPI',
  'GraphQL',
  'gRPC',
  'Avro',
  'WSDL',
  'TypeSpec',
  'OData',
];

/** Absolute path of a file under `src/app`, for the source-level assertions. */
const appFile = (...parts: string[]) => join(__dirname, '..', 'src', 'app', ...parts);

beforeEach(() => {
  mockSignIn.mockReset();
});

describe('AuthShell — the frame every signed-out page gets', () => {
  it('draws the hex canvas and exactly one main landmark', () => {
    const { container } = render(
      <AuthShell brand={<p>brand</p>}>
        <p>card</p>
      </AuthShell>
    );

    expect(container.querySelector('.hex-bg')).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('splits when a brand panel is given, and names that panel', () => {
    render(
      <AuthShell brand={<p>brand</p>}>
        <p>card</p>
      </AuthShell>
    );

    expect(screen.getByRole('main')).toHaveClass('auth-split');
    // The panel is a region so a screen-reader user can skip past the marketing copy.
    expect(screen.getByRole('region', { name: 'About Apiome' })).toBeInTheDocument();
  });

  it('centres the card when no brand panel is given — the shape 4.2/4.3 will use', () => {
    render(
      <AuthShell>
        <p>card</p>
      </AuthShell>
    );

    expect(screen.getByRole('main')).toHaveClass('auth-center');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});

describe('login page — the brand panel', () => {
  it('carries the bee lock-up, the positioning line and the headline', () => {
    render(<LoginClient ssoProviders={PROVIDERS} />);

    const panel = screen.getByRole('region', { name: 'About Apiome' });
    expect(within(panel).getByText('The API design environment')).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Design. Version.Publish your APIs.'
    );
    expect(within(panel).getByText(/Model your API once/)).toBeInTheDocument();
  });

  it('shows the bee in the panel and again on the card, one per viewport', () => {
    const { container } = render(<LoginClient ssoProviders={PROVIDERS} />);

    // Two copies in the DOM: the lock-up (brand panel, ≥1000 px) and the glyph the card
    // shows below that width. `globals.css` turns exactly one of them on — see
    // `auth-surfaces-css.test.ts`, which pins that both halves live in one media block.
    expect(container.querySelectorAll('img.bee-glyph')).toHaveLength(2);
    expect(container.querySelector('.auth-brand__lockup')).toBeInTheDocument();
    expect(container.querySelector('.auth-card__logo')).toBeInTheDocument();
  });

  it('floats the eight formats as registry pills, hidden from assistive tech', () => {
    const { container } = render(<LoginClient ssoProviders={PROVIDERS} />);

    const chips = container.querySelector('.auth-chips')!;
    expect(chips).toHaveAttribute('aria-hidden', 'true');

    const pills = within(chips as HTMLElement).getAllByTestId('format-pill');
    expect(pills.map((pill) => pill.textContent)).toEqual(FORMAT_CHIP_LABELS);

    // Each pill keeps the format's own identity hue — the `.fmt--*` class the catalog uses
    // — rather than a colour invented for this page.
    for (const pill of pills) {
      expect(pill.className).toMatch(/\bfmt fmt--\w+/);
    }
  });

  it('scatters the drift so the eight do not rise as one block', () => {
    const { container } = render(<LoginClient ssoProviders={PROVIDERS} />);
    const pills = Array.from(container.querySelectorAll<HTMLElement>('.auth-chips > *'));

    const delays = pills.map((pill) => pill.style.getPropertyValue('--chip-delay'));
    expect(new Set(delays).size).toBe(pills.length);
    for (const pill of pills) {
      expect(pill.style.getPropertyValue('--chip-rot')).toMatch(/^-?\d+deg$/);
    }
  });
});

describe('login page — the auth card', () => {
  it('keeps its test ids and the card class the skin hangs off', () => {
    render(<LoginClient ssoProviders={PROVIDERS} />);
    expect(screen.getByTestId('login-card')).toHaveClass('auth-card');
  });

  it('leads with the mode heading, its sub, and the intro-video link', () => {
    render(<LoginClient ssoProviders={PROVIDERS} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome back');
    expect(screen.getByText('Sign in to continue to your workspace')).toBeInTheDocument();
    const video = screen.getByRole('link', { name: /Watch our intro video/ });
    expect(video).toHaveAttribute('target', '_blank');
    expect(video).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('drops the intro link and the trust badges in sign-up mode', () => {
    render(<LoginClient ssoProviders={PROVIDERS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create one' }));

    expect(screen.queryByRole('link', { name: /Watch our intro video/ })).not.toBeInTheDocument();
    expect(screen.queryByText('No credit card')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Create your account');
  });

  it('closes with the trust badges and the terms line', () => {
    const { container } = render(<LoginClient ssoProviders={PROVIDERS} />);

    for (const promise of ['Secure', 'Free to start', 'No credit card']) {
      expect(screen.getByText(promise)).toBeInTheDocument();
    }
    const terms = container.querySelector('.auth-terms')!;
    expect(within(terms as HTMLElement).getByText('Terms of Service')).toBeInTheDocument();
    expect(within(terms as HTMLElement).getByText('Privacy Policy')).toBeInTheDocument();
  });
});

describe('login page — the message banner is the Hive Alert', () => {
  it('renders an error in the danger tone, announced assertively', () => {
    render(<LoginClient ssoProviders={PROVIDERS} error="sign-in-failed" />);

    const banner = screen.getByTestId('login-banner');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveAttribute('aria-live', 'assertive');
    expect(banner.className).toContain('bg-danger-soft');
  });

  it('offers "Try again" as a link back to a clean login page', () => {
    render(<LoginClient ssoProviders={PROVIDERS} error="sign-in-failed" callbackUrl="/ade" />);

    const retry = screen.getByRole('link', { name: /Try again/ });
    expect(retry).toHaveAttribute('href', `/login?callbackUrl=${encodeURIComponent('/ade')}`);
    // Rendered through `Button asChild`, so it is a real link wearing the pill chrome.
    expect(retry).toHaveClass('rounded-full');
  });

  it('uses the ok tone and a polite announcement for in-page sign-up feedback', async () => {
    const { createSignupRequest } = jest.requireMock('../lib/db/helper') as {
      createSignupRequest: jest.Mock;
    };
    createSignupRequest.mockResolvedValue(
      JSON.stringify({ success: true, message: 'Check your inbox to verify your email.' })
    );

    render(<LoginClient ssoProviders={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
    fireEvent.change(screen.getByLabelText('Full Name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter22' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create Account' }).closest('form')!);

    const banner = await screen.findByTestId('login-banner');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
    expect(banner.className).toContain('bg-ok-soft');
  });
});

describe('login page — the SSO block', () => {
  it('draws one full-width provider row per provider, with a trailing arrow', () => {
    const { container } = render(<LoginClient ssoProviders={PROVIDERS} />);

    const rows = container.querySelectorAll('.auth-sso');
    expect(rows).toHaveLength(2);
    expect(container.querySelectorAll('.auth-sso__arrow')).toHaveLength(2);
  });

  it('replaces the rows with a live "Connecting…" tile during a redirect', async () => {
    render(<LoginClient ssoProviders={PROVIDERS} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with GitHub' }));

    const tile = await screen.findByRole('status');
    expect(tile).toHaveClass('auth-wait');
    expect(tile).toHaveAttribute('aria-live', 'polite');
    expect(within(tile).getByText('Connecting…')).toBeInTheDocument();
    expect(within(tile).getByText('Redirecting to authentication provider')).toBeInTheDocument();
  });

  it('keeps the expand control a single element in both spellings', () => {
    const { container, rerender } = render(<LoginClient ssoProviders={PROVIDERS} />);

    // Collapsed: a button carrying the expander contract.
    const expand = screen.getByRole('button', { name: 'or use your email' });
    expect(expand).toHaveClass('auth-divider');
    expect(expand).toHaveAttribute('aria-controls', 'credentials-form');

    fireEvent.click(expand);
    rerender(<LoginClient ssoProviders={PROVIDERS} />);

    // Expanded: the same class, now a plain label with no control semantics.
    const divider = container.querySelector('.auth-divider')!;
    expect(divider.tagName).toBe('DIV');
    expect(divider).toHaveTextContent('or use your email');
  });
});

describe('login page — the credentials fields', () => {
  it('gives every field a label tied to its control and a leading glyph', () => {
    const { container } = render(<LoginClient ssoProviders={[]} />);

    expect(screen.getByLabelText('Email Address')).toHaveAttribute('id', 'email');
    expect(screen.getByLabelText('Password')).toHaveAttribute('id', 'password');
    // One `.input-wrap` per field, each carrying the glyph inside the control's box.
    const wraps = container.querySelectorAll('.input-wrap');
    expect(wraps).toHaveLength(2);
    for (const wrap of wraps) expect(wrap.querySelector('svg')).toBeInTheDocument();
  });

  it('puts "Forgot your password?" on the password label row, in sign-in mode only', () => {
    render(<LoginClient ssoProviders={[]} />);
    expect(screen.getByRole('link', { name: 'Forgot your password?' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create one' }));
    expect(screen.queryByRole('link', { name: 'Forgot your password?' })).not.toBeInTheDocument();
  });

  it('marks the rejected pair after a failed credentials attempt', () => {
    render(<LoginClient ssoProviders={PROVIDERS} error="CredentialsSignin" />);

    const email = screen.getByLabelText('Email Address');
    const password = screen.getByLabelText('Password');

    // `aria-invalid` is the single flag: it reddens the hairline *and* is what a screen
    // reader announces, so the ring and the announcement cannot disagree.
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    // Both boxes redden — the *pair* was rejected — but the sentence is printed once,
    // under the password, which is where the mockup's error variant puts it.
    expect(screen.getAllByText('Incorrect email or password.')).toHaveLength(1);
    expect(password).toHaveAttribute('aria-describedby', 'password-error');
    expect(email).not.toHaveAttribute('aria-describedby');
  });

  it('stops marking the pair as soon as the reader starts fixing it', () => {
    render(<LoginClient ssoProviders={PROVIDERS} error="CredentialsSignin" />);

    fireEvent.change(screen.getByLabelText('Email Address'), {
      target: { name: 'email', value: 'ada@example.com' },
    });

    expect(screen.getByLabelText('Email Address')).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('Incorrect email or password.')).not.toBeInTheDocument();
    // The banner still stands: the field note says *where*, the banner says *what*.
    expect(screen.getByTestId('login-banner')).toBeInTheDocument();
  });

  it('never marks the sign-up form, which has no rejected pair to mark', () => {
    render(<LoginClient ssoProviders={PROVIDERS} error="CredentialsSignin" />);
    fireEvent.click(screen.getByRole('button', { name: 'Create one' }));

    expect(screen.queryByText('Incorrect email or password.')).not.toBeInTheDocument();
  });
});

describe('BetaBadge — the watermark became a chip', () => {
  const original = process.env.NEXT_PUBLIC_BETA_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_BETA_MODE;
    else process.env.NEXT_PUBLIC_BETA_MODE = original;
  });

  it('renders nothing when the deployment is not in beta mode', () => {
    process.env.NEXT_PUBLIC_BETA_MODE = '';
    const { container } = render(<BetaBadge />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a honey chip when it is', () => {
    process.env.NEXT_PUBLIC_BETA_MODE = '1';
    render(<BetaBadge />);
    const badge = screen.getByText('BETA');
    expect(badge.className).toContain('bg-honey-soft');
  });

  it('rides beside the bee, in both of the places the bee appears', () => {
    process.env.NEXT_PUBLIC_BETA_MODE = '1';
    const { container } = render(<LoginClient ssoProviders={PROVIDERS} />);

    // One in the brand panel (visible ≥1000 px), one in the card's logo row (visible
    // below it) — the chip follows the mark, so the same one-per-width rule covers it.
    const chips = screen.getAllByText('BETA');
    expect(chips).toHaveLength(2);
    expect(container.querySelector('.auth-card__logo')).toContainElement(chips[1]);
    // And nothing tiles it across the page any more.
    expect(container.textContent!.match(/BETA/g)).toHaveLength(2);
  });
});

describe('login page — nothing left that names a colour', () => {
  const sources = [
    appFile('login', 'LoginClient.tsx'),
    appFile('login', 'LoginBrandPanel.tsx'),
    appFile('components', 'auth', 'AuthShell.tsx'),
    appFile('components', 'auth', 'AuthField.tsx'),
    appFile('components', 'auth', 'BetaBadge.tsx'),
  ];

  it.each(sources)('%s uses no Tailwind palette utility', (path) => {
    // Comments are stripped first: these files document the palette classes they replaced.
    const code = readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // `-slate-`, not `slate`: `translate-y-px` is geometry, not a colour.
    expect(code).not.toMatch(
      /\b(?:bg|text|border|ring|shadow|from|via|to|fill|stroke|placeholder|decoration)-(?:slate|gray|zinc|neutral|stone|indigo|violet|purple|fuchsia|sky|blue|cyan|emerald|red|pink|amber)-\d{2,3}\b/
    );
  });

  it('no longer imports the aurora module or the tiled watermark', () => {
    // Import statements only — the docblock names both on purpose, to say what it replaced.
    const imports = readFileSync(appFile('login', 'LoginClient.tsx'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('import '));

    expect(imports.join('\n')).not.toContain('login.module.css');
    expect(imports.join('\n')).not.toContain('BetaBackground');
  });

  it('has taken the watermark component with it', () => {
    // The two-factor screen was the last consumer; HIVE-4.2 (#5296) re-skinned it against
    // `BetaBadge` and deleted the file, so nothing may reach for it again.
    expect(existsSync(appFile('login', 'BetaBackground.tsx'))).toBe(false);

    const twoFactor = readFileSync(appFile('login', '2fa', 'TwoFactorClient.tsx'), 'utf8');
    expect(twoFactor).not.toContain('BetaBackground');
  });
});
