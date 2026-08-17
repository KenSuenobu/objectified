/**
 * The markup half of the two-factor redesign (HIVE-4.2, #5296).
 *
 * `login-two-factor.test.tsx` pins the flow — both methods, the stored callback, every
 * error string — and still passes unchanged, because the re-skin moved none of it. This
 * suite pins what the re-skin *is*, so a later ticket cannot quietly undo it:
 *
 *   1. The screen is drawn in the shared `AuthShell` in its centred shape, on the same hex
 *      canvas as `/login`, with one `<main>` and one `<h1>`.
 *   2. The mark above the card is the lock-up, with the honey beta chip beside it — the
 *      tiled watermark and its module are gone.
 *   3. The method switcher is a real `role="tablist"`: one Tab stop, arrow keys move
 *      between the two methods and select as they move.
 *   4. The code box takes six digits and nothing else, however they arrive, and submit
 *      stays disabled until it has all six.
 *   5. Nothing on the page names a colour.
 */
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  TWO_FACTOR_METHODS_STORAGE_KEY,
  type TwoFactorMethod,
} from '@lib/auth/two-factor-callback';

const mockVerifyTotp = jest.fn();
const mockVerifyOtp = jest.fn();
const mockSendOtp = jest.fn();
const mockBrowserNavigate = jest.fn();

jest.mock('@lib/auth/auth-client', () => ({
  authClient: {
    twoFactor: {
      verifyTotp: (...args: unknown[]) => mockVerifyTotp(...args),
      verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args),
      sendOtp: (...args: unknown[]) => mockSendOtp(...args),
    },
  },
}));

jest.mock('@lib/auth/browser-navigate', () => ({
  browserNavigate: (...args: unknown[]) => mockBrowserNavigate(...args),
}));

import TwoFactorClient from '@/app/login/2fa/TwoFactorClient';

/** The source of the client, for the assertions that read it rather than render it. */
const CLIENT_SOURCE = join(
  __dirname,
  '..',
  'src',
  'app',
  'login',
  '2fa',
  'TwoFactorClient.tsx'
);

/**
 * Render the screen with a given set of offered methods.
 *
 * @param methods What the challenge offered; omitted leaves storage empty, which the
 *   callback module resolves to TOTP-only.
 * @returns Testing Library's render result.
 */
function renderScreen(methods?: TwoFactorMethod[]) {
  if (methods) {
    window.sessionStorage.setItem(TWO_FACTOR_METHODS_STORAGE_KEY, JSON.stringify(methods));
  }
  return render(<TwoFactorClient callbackUrl="/ade" />);
}

beforeEach(() => {
  jest.clearAllMocks();
  window.sessionStorage.clear();
});

describe('two-factor screen — the frame', () => {
  it('is the centred AuthShell on the hex canvas', () => {
    // No brand panel: the reader is mid-sign-in, and the whole page is one decision.
    const { container } = renderScreen();

    expect(container.querySelector('.hex-bg')).toBeInTheDocument();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('main')).toHaveClass('auth-center');
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('gives the card exactly one h1, and the Hive card class', () => {
    renderScreen();

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Two-factor authentication'
    );
    expect(screen.getByTestId('two-factor-card')).toHaveClass('auth-card');
  });

  it('names the product above the card with the bee lock-up', () => {
    const { container } = renderScreen();

    const brandbar = container.querySelector('.auth-brandbar');
    expect(brandbar).toBeInTheDocument();
    expect(within(brandbar as HTMLElement).getByText('apiome')).toBeInTheDocument();
  });

  it('draws the subject glyph as the hex tile, hidden from assistive technology', () => {
    // The heading says which factor this is; the tile is ornament and must not say it
    // twice — it carries no accessible name at all.
    const { container } = renderScreen();

    const tile = container.querySelector('.auth-icon');
    expect(tile).toBeInTheDocument();
    expect(tile).toHaveAttribute('aria-hidden', 'true');
  });

  it('offers one way back, to the login page it came from', () => {
    renderScreen();

    const back = screen.getByRole('link', { name: /back to sign in/i });
    expect(back).toHaveAttribute('href', '/login?callbackUrl=%2Fade');
    // Every link on these pages sits in a sentence, so it needs more than colour.
    expect(back).toHaveClass('auth-link');
  });
});

describe('two-factor screen — the beta chip replaced the watermark', () => {
  const original = process.env.NEXT_PUBLIC_BETA_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.NEXT_PUBLIC_BETA_MODE;
    else process.env.NEXT_PUBLIC_BETA_MODE = original;
  });

  it('shows the honey chip beside the mark when the deployment is in beta', () => {
    process.env.NEXT_PUBLIC_BETA_MODE = 'true';
    const { container } = renderScreen();

    const brandbar = container.querySelector('.auth-brandbar') as HTMLElement;
    expect(within(brandbar).getByText('BETA')).toBeInTheDocument();
  });

  it('shows nothing at all when it is not', () => {
    delete process.env.NEXT_PUBLIC_BETA_MODE;
    renderScreen();

    expect(screen.queryByText('BETA')).not.toBeInTheDocument();
  });

  it('has retired the tiled watermark component with the page that used it', () => {
    expect(
      existsSync(join(__dirname, '..', 'src', 'app', 'login', 'BetaBackground.tsx'))
    ).toBe(false);
    expect(readFileSync(CLIENT_SOURCE, 'utf8')).not.toContain('BetaBackground');
  });
});

describe('two-factor screen — the method switcher', () => {
  it('is a named tablist, and only appears when both methods are offered', () => {
    renderScreen(['totp', 'otp']);

    const list = screen.getByRole('tablist', { name: 'Verification method' });
    expect(list).toHaveClass('auth-methods');
    expect(within(list).getAllByRole('tab')).toHaveLength(2);
  });

  it('is absent when the challenge offered a single method', () => {
    renderScreen(['otp']);

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    // …and the single method's form is still the one on screen.
    expect(screen.getByTestId('two-factor-send-otp')).toBeInTheDocument();
  });

  it('keeps one Tab stop for the pair and moves with the arrow keys', async () => {
    // The WAI-ARIA tabs pattern: the group is one stop, and Left/Right walk it. Selection
    // follows focus, which is what clears the code box for the method being left behind.
    const user = userEvent.setup();
    renderScreen(['totp', 'otp']);

    // The stop is on the group, which then hands focus to the option that is selected —
    // so the pair costs one Tab press, not two.
    const list = screen.getByRole('tablist');
    expect(list).toHaveAttribute('tabindex', '0');

    const [authenticator, emailCode] = screen.getAllByRole('tab');
    expect(authenticator).toHaveAttribute('tabindex', '-1');
    expect(emailCode).toHaveAttribute('tabindex', '-1');

    authenticator.focus();
    await user.keyboard('{ArrowRight}');

    expect(emailCode).toHaveFocus();
    expect(emailCode).toHaveAttribute('aria-selected', 'true');
    // The stop moved with the focus: still one of them, and it is the selected one.
    expect(emailCode).toHaveAttribute('tabindex', '0');
    expect(authenticator).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('two-factor-send-otp')).toBeInTheDocument();

    await user.keyboard('{ArrowLeft}');

    expect(authenticator).toHaveFocus();
    expect(screen.getByLabelText('Authentication code')).toBeInTheDocument();
  });

  it('does not steal focus back into the code box when a panel is re-shown', async () => {
    // The box is autofocused on arrival — but never again, or the arrow keys would strand
    // the reader in the field they were trying to move past.
    const user = userEvent.setup();
    renderScreen(['totp', 'otp']);

    const [authenticator, emailCode] = screen.getAllByRole('tab');
    authenticator.focus();
    await user.keyboard('{ArrowRight}{ArrowLeft}');

    expect(emailCode).not.toHaveFocus();
    expect(authenticator).toHaveFocus();
  });
});

describe('two-factor screen — the code box', () => {
  it('asks for six digits, by every affordance a browser reads', () => {
    renderScreen();

    const box = screen.getByLabelText('Authentication code');
    expect(box).toHaveAttribute('inputmode', 'numeric');
    expect(box).toHaveAttribute('autocomplete', 'one-time-code');
    expect(box).toHaveAttribute('maxlength', '6');
    expect(box).toHaveAttribute('placeholder', '000000');
    // The hint under it says the same thing to a reader, and is announced with the field.
    expect(box).toHaveAccessibleDescription(/digits only/i);
  });

  it('keeps the digits of a pasted code and drops everything else', () => {
    // A code pasted out of a mail client arrives with spaces, a newline, or both.
    renderScreen();

    const box = screen.getByLabelText('Authentication code');
    fireEvent.change(box, { target: { value: ' 123 456\n' } });

    expect(box).toHaveValue('123456');
    expect(screen.getByTestId('two-factor-submit')).toBeEnabled();
  });

  it('never holds more than six digits', () => {
    renderScreen();

    const box = screen.getByLabelText('Authentication code');
    fireEvent.change(box, { target: { value: '1234567890' } });

    expect(box).toHaveValue('123456');
  });

  it('keeps submit disabled until the code is complete', () => {
    renderScreen();

    const submit = screen.getByTestId('two-factor-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Authentication code'), {
      target: { value: '12345' },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Authentication code'), {
      target: { value: '123456' },
    });
    expect(submit).toBeEnabled();
  });

  it('submits a pasted code cleanly', async () => {
    mockVerifyTotp.mockResolvedValue({ data: { token: 'ok' }, error: null });
    renderScreen();

    fireEvent.change(screen.getByLabelText('Authentication code'), {
      target: { value: '123 456' },
    });
    fireEvent.click(screen.getByTestId('two-factor-submit'));

    await screen.findByText('Verifying…');
    expect(mockVerifyTotp).toHaveBeenCalledWith({ code: '123456' });
  });

  it('reddens the box rather than printing the banner twice', async () => {
    renderScreen();

    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '12' } });
    fireEvent.submit(screen.getByTestId('two-factor-card').querySelector('form')!);

    // One sentence, in the banner. The field only carries the flag that is announced.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter the 6-digit code from your authenticator app.'
    );
    expect(screen.getByLabelText('Authentication code')).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('two-factor screen — the email code', () => {
  it('walks the send button through its three labels', async () => {
    mockSendOtp.mockResolvedValue({ data: { status: true }, error: null });
    renderScreen(['otp']);

    const send = screen.getByTestId('two-factor-send-otp');
    expect(send).toHaveTextContent('Send email code');

    fireEvent.click(send);

    expect(await screen.findByText('Resend email code')).toBeInTheDocument();
  });

  it('announces that the code was sent, which the changed description cannot', async () => {
    // A paragraph that quietly changes its words is not read out; a status region is.
    mockSendOtp.mockResolvedValue({ data: { status: true }, error: null });
    renderScreen(['otp']);

    fireEvent.click(screen.getByTestId('two-factor-send-otp'));

    const sent = await screen.findByTestId('two-factor-otp-sent');
    expect(sent).toHaveAttribute('role', 'status');
    expect(screen.getByText('Enter the 6-digit code we emailed you.')).toBeInTheDocument();
  });

  it('shows the failure instead of the confirmation when the send fails', async () => {
    mockSendOtp.mockResolvedValue({ data: null, error: { message: '' } });
    renderScreen(['otp']);

    fireEvent.click(screen.getByTestId('two-factor-send-otp'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not send the email code. Try again.'
    );
    expect(screen.queryByTestId('two-factor-otp-sent')).not.toBeInTheDocument();
  });
});

describe('two-factor screen — nothing names a colour', () => {
  it('uses no palette utility and no page-local stylesheet', () => {
    const source = readFileSync(CLIENT_SOURCE, 'utf8');

    // `-slate-`, not `slate`: `translate-y-px` is geometry, not a colour.
    expect(source).not.toMatch(
      /\b(?:bg|text|border|ring|shadow|from|via|to|fill|stroke|placeholder|decoration)-(?:slate|gray|zinc|neutral|stone|indigo|violet|purple|fuchsia|sky|blue|cyan|emerald|red|pink|amber)-\d{2,3}\b/
    );
    expect(source).not.toContain('.module.css');
  });
});
