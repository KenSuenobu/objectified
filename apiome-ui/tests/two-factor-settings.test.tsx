/**
 * Profile TwoFactorSettings enrollment / disable UI (OLO-9.13 #5014).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TwoFactorSettings } from '@/app/ade/dashboard/profile/TwoFactorSettings';

const mockEnable = jest.fn();
const mockDisable = jest.fn();
const mockVerifyTotp = jest.fn();
const mockUpdate = jest.fn(async () => {});
const mockUseAuthSession = jest.fn();

jest.mock('@lib/auth/auth-client', () => ({
  authClient: {
    twoFactor: {
      enable: (...args: unknown[]) => mockEnable(...args),
      disable: (...args: unknown[]) => mockDisable(...args),
      verifyTotp: (...args: unknown[]) => mockVerifyTotp(...args),
    },
  },
}));

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => mockUseAuthSession(),
}));

jest.mock('react-qr-code', () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => <div data-testid="qr-mock">{value}</div>,
}));

describe('TwoFactorSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuthSession.mockReturnValue({
      data: {
        user: {
          user_id: 'u1',
          email: 'a@b.co',
          twoFactorEnabled: false,
        },
        expires: '',
        twoFactorElevated: false,
      },
      update: mockUpdate,
    });
  });

  it('shows Off status and opens the enable dialog', () => {
    render(<TwoFactorSettings />);

    expect(screen.getByTestId('two-factor-status')).toHaveTextContent('Off');
    fireEvent.click(screen.getByTestId('two-factor-enable-open'));
    expect(screen.getByTestId('two-factor-enroll-password')).toBeInTheDocument();
  });

  it('enrolls through password → QR → verify → backup codes', async () => {
    mockEnable.mockResolvedValue({
      data: {
        totpURI: 'otpauth://totp/apiome:a@b.co?secret=ABC',
        backupCodes: ['AAAA-AAAA', 'BBBB-BBBB'],
      },
      error: null,
    });
    mockVerifyTotp.mockResolvedValue({ data: {}, error: null });

    render(<TwoFactorSettings />);
    fireEvent.click(screen.getByTestId('two-factor-enable-open'));
    fireEvent.change(screen.getByTestId('two-factor-enroll-password'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByTestId('two-factor-enroll-continue'));

    await waitFor(() => {
      expect(mockEnable).toHaveBeenCalledWith({ password: 'secret' });
      expect(screen.getByTestId('two-factor-qr')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('two-factor-enroll-code'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByTestId('two-factor-enroll-verify'));

    await waitFor(() => {
      expect(mockVerifyTotp).toHaveBeenCalledWith({ code: '123456' });
      expect(mockUpdate).toHaveBeenCalled();
      expect(screen.getByTestId('two-factor-backup-codes')).toHaveTextContent('AAAA-AAAA');
    });
  });

  it('disables 2FA with a password when already enabled', async () => {
    mockUseAuthSession.mockReturnValue({
      data: {
        user: { user_id: 'u1', email: 'a@b.co', twoFactorEnabled: true },
        expires: '',
        twoFactorElevated: true,
      },
      update: mockUpdate,
    });
    mockDisable.mockResolvedValue({ data: { status: true }, error: null });

    render(<TwoFactorSettings />);
    expect(screen.getByTestId('two-factor-status')).toHaveTextContent('Enabled');
    fireEvent.click(screen.getByTestId('two-factor-disable-open'));
    fireEvent.change(screen.getByTestId('two-factor-disable-password'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByTestId('two-factor-disable-confirm'));

    await waitFor(() => {
      expect(mockDisable).toHaveBeenCalledWith({ password: 'secret' });
      expect(mockUpdate).toHaveBeenCalled();
    });
  });
});
