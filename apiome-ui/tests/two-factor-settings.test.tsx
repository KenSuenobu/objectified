/**
 * Profile TwoFactorSettings enrollment / disable / self-service UI
 * (OLO-9.13 #5014 + OLO-9.15 #5015 + OLO-9.50 #5070).
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TwoFactorSettings } from '@/app/ade/dashboard/profile/TwoFactorSettings';

const mockEnable = jest.fn();
const mockDisable = jest.fn();
const mockVerifyTotp = jest.fn();
const mockGenerateBackupCodes = jest.fn();
const mockUpdate = jest.fn(async () => {});
const mockUseAuthSession = jest.fn();
const mockGetBackupCodeStatus = jest.fn(async () => ({ remaining: null as number | null }));
const mockGetTrustedDeviceStatus = jest.fn(async () => ({ trusted: false }));
const mockRevokeThisTrustedDevice = jest.fn(async () => ({ ok: true }));
const mockGetEmailOtpAvailability = jest.fn(async () => ({ available: false }));

jest.mock('@lib/auth/auth-client', () => ({
  authClient: {
    twoFactor: {
      enable: (...args: unknown[]) => mockEnable(...args),
      disable: (...args: unknown[]) => mockDisable(...args),
      verifyTotp: (...args: unknown[]) => mockVerifyTotp(...args),
      generateBackupCodes: (...args: unknown[]) => mockGenerateBackupCodes(...args),
    },
  },
}));

jest.mock('@lib/auth/session-client', () => ({
  useAuthSession: () => mockUseAuthSession(),
}));

jest.mock('@lib/auth/two-factor-profile-actions', () => ({
  getBackupCodeStatus: (...args: unknown[]) => mockGetBackupCodeStatus(...args),
  getTrustedDeviceStatus: (...args: unknown[]) => mockGetTrustedDeviceStatus(...args),
  revokeThisTrustedDevice: (...args: unknown[]) => mockRevokeThisTrustedDevice(...args),
  getEmailOtpAvailability: (...args: unknown[]) => mockGetEmailOtpAvailability(...args),
}));

jest.mock('react-qr-code', () => ({
  __esModule: true,
  default: ({ value }: { value: string }) => <div data-testid="qr-mock">{value}</div>,
}));

describe('TwoFactorSettings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBackupCodeStatus.mockResolvedValue({ remaining: null });
    mockGetTrustedDeviceStatus.mockResolvedValue({ trusted: false });
    mockRevokeThisTrustedDevice.mockResolvedValue({ ok: true });
    mockGetEmailOtpAvailability.mockResolvedValue({ available: false });
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
    mockGetBackupCodeStatus.mockResolvedValue({ remaining: 8 });
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

  it('shows remaining backup codes and regenerates with a password', async () => {
    mockUseAuthSession.mockReturnValue({
      data: {
        user: { user_id: 'u1', email: 'a@b.co', twoFactorEnabled: true },
        expires: '',
        twoFactorElevated: true,
      },
      update: mockUpdate,
    });
    mockGetBackupCodeStatus.mockResolvedValue({ remaining: 7 });
    mockGenerateBackupCodes.mockResolvedValue({
      data: { backupCodes: ['CCCC-CCCC', 'DDDD-DDDD'] },
      error: null,
    });

    render(<TwoFactorSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-backup-remaining')).toHaveTextContent('7 remaining');
      expect(screen.getByTestId('two-factor-methods')).toHaveTextContent('Authenticator app (TOTP)');
      expect(screen.getByTestId('two-factor-recovery-guidance')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('two-factor-regen-open'));
    fireEvent.change(screen.getByTestId('two-factor-regen-password'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByTestId('two-factor-regen-confirm'));

    await waitFor(() => {
      expect(mockGenerateBackupCodes).toHaveBeenCalledWith({ password: 'secret' });
      expect(screen.getByTestId('two-factor-backup-codes')).toHaveTextContent('CCCC-CCCC');
      expect(screen.getByTestId('two-factor-backup-remaining')).toHaveTextContent('2 remaining');
    });
  });

  it('forgets this trusted device when the browser is trusted', async () => {
    mockUseAuthSession.mockReturnValue({
      data: {
        user: { user_id: 'u1', email: 'a@b.co', twoFactorEnabled: true },
        expires: '',
        twoFactorElevated: true,
      },
      update: mockUpdate,
    });
    mockGetBackupCodeStatus.mockResolvedValue({ remaining: 10 });
    mockGetTrustedDeviceStatus.mockResolvedValue({ trusted: true });

    render(<TwoFactorSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-trusted-status')).toHaveTextContent('This browser is trusted');
    });

    fireEvent.click(screen.getByTestId('two-factor-forget-device'));

    await waitFor(() => {
      expect(mockRevokeThisTrustedDevice).toHaveBeenCalled();
      expect(screen.getByTestId('two-factor-trusted-status')).toHaveTextContent('not marked as trusted');
    });
  });

  it('surfaces email OTP when SendGrid is configured (OLO-9.50)', async () => {
    mockUseAuthSession.mockReturnValue({
      data: {
        user: { user_id: 'u1', email: 'a@b.co', twoFactorEnabled: true },
        expires: '',
        twoFactorElevated: true,
      },
      update: mockUpdate,
    });
    mockGetBackupCodeStatus.mockResolvedValue({ remaining: 5 });
    mockGetEmailOtpAvailability.mockResolvedValue({ available: true });

    render(<TwoFactorSettings />);

    await waitFor(() => {
      expect(screen.getByTestId('two-factor-method-email-otp')).toBeInTheDocument();
      expect(screen.getByTestId('two-factor-email-otp-info')).toHaveTextContent(/email/i);
    });
  });
});
