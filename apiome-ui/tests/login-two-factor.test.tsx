/**
 * Login 2FA step UI tests (OLO-9.13 #5014).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TwoFactorClient from '@/app/login/2fa/TwoFactorClient';
import { TWO_FACTOR_CALLBACK_STORAGE_KEY } from '@lib/auth/two-factor-callback';

const mockVerifyTotp = jest.fn();
const mockBrowserNavigate = jest.fn();

jest.mock('@lib/auth/auth-client', () => ({
  authClient: {
    twoFactor: {
      verifyTotp: (...args: unknown[]) => mockVerifyTotp(...args),
    },
  },
}));

jest.mock('@lib/auth/browser-navigate', () => ({
  browserNavigate: (...args: unknown[]) => mockBrowserNavigate(...args),
}));

jest.mock('@/app/hooks/useDarkMode', () => ({
  useDarkMode: () => false,
}));

jest.mock('@/app/login/BetaBackground', () => ({
  __esModule: true,
  default: () => null,
}));

describe('TwoFactorClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.sessionStorage.clear();
  });

  it('rejects a non-6-digit code without calling the API', async () => {
    render(<TwoFactorClient callbackUrl="/ade" />);

    fireEvent.change(screen.getByLabelText(/authentication code/i), { target: { value: '12' } });
    fireEvent.submit(screen.getByTestId('two-factor-card').querySelector('form')!);

    expect(await screen.findByRole('alert')).toHaveTextContent(/6-digit/i);
    expect(mockVerifyTotp).not.toHaveBeenCalled();
  });

  it('verifies a valid code and navigates to the stored callback', async () => {
    window.sessionStorage.setItem(TWO_FACTOR_CALLBACK_STORAGE_KEY, '/ade/dashboard');
    mockVerifyTotp.mockResolvedValue({ data: { token: 'ok' }, error: null });

    render(<TwoFactorClient callbackUrl="/ade" />);

    fireEvent.change(screen.getByLabelText(/authentication code/i), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('two-factor-submit'));

    await waitFor(() => {
      expect(mockVerifyTotp).toHaveBeenCalledWith({ code: '123456' });
      expect(mockBrowserNavigate).toHaveBeenCalledWith('/ade/dashboard');
    });
  });

  it('shows an error when verifyTotp fails', async () => {
    mockVerifyTotp.mockResolvedValue({
      data: null,
      error: { message: 'Invalid code' },
    });

    render(<TwoFactorClient callbackUrl="/ade" />);

    fireEvent.change(screen.getByLabelText(/authentication code/i), {
      target: { value: '000000' },
    });
    fireEvent.click(screen.getByTestId('two-factor-submit'));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid code');
  });
});
