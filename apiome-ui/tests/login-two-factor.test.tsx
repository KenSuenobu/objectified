/**
 * Login 2FA step UI tests (OLO-9.13 #5014 + OLO-9.50 #5070).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TwoFactorClient from '@/app/login/2fa/TwoFactorClient';
import {
  TWO_FACTOR_CALLBACK_STORAGE_KEY,
  TWO_FACTOR_METHODS_STORAGE_KEY,
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

  it('verifies a valid TOTP code and navigates to the stored callback', async () => {
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

  it('sends and verifies email OTP when methods include otp only', async () => {
    window.sessionStorage.setItem(TWO_FACTOR_METHODS_STORAGE_KEY, JSON.stringify(['otp']));
    window.sessionStorage.setItem(TWO_FACTOR_CALLBACK_STORAGE_KEY, '/ade');
    mockSendOtp.mockResolvedValue({ data: { status: true }, error: null });
    mockVerifyOtp.mockResolvedValue({ data: { token: 'ok' }, error: null });

    render(<TwoFactorClient callbackUrl="/ade" />);

    expect(screen.getByTestId('two-factor-send-otp')).toBeInTheDocument();
    expect(screen.queryByTestId('two-factor-method-switcher')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('two-factor-send-otp'));
    await waitFor(() => expect(mockSendOtp).toHaveBeenCalled());

    fireEvent.change(screen.getByTestId('two-factor-otp-code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByTestId('two-factor-otp-submit'));

    await waitFor(() => {
      expect(mockVerifyOtp).toHaveBeenCalledWith({ code: '654321' });
      expect(mockBrowserNavigate).toHaveBeenCalledWith('/ade');
    });
  });

  it('lets the user switch between authenticator and email when both methods are offered', async () => {
    window.sessionStorage.setItem(
      TWO_FACTOR_METHODS_STORAGE_KEY,
      JSON.stringify(['totp', 'otp'])
    );

    render(<TwoFactorClient callbackUrl="/ade" />);

    expect(screen.getByTestId('two-factor-method-switcher')).toBeInTheDocument();
    expect(screen.getByTestId('two-factor-submit')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('two-factor-method-otp'));
    expect(screen.getByTestId('two-factor-send-otp')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('two-factor-method-totp'));
    expect(screen.getByTestId('two-factor-submit')).toBeInTheDocument();
  });
});
