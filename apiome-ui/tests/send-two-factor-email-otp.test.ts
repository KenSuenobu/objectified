/**
 * SendGrid 2FA email OTP helper (OLO-9.50 #5070).
 */

const mockSetApiKey = jest.fn();
const mockSend = jest.fn();

jest.mock('@sendgrid/mail', () => ({
  __esModule: true,
  default: {
    setApiKey: (...args: unknown[]) => mockSetApiKey(...args),
    send: (...args: unknown[]) => mockSend(...args),
  },
}));

import {
  isTwoFactorEmailOtpConfigured,
  sendTwoFactorEmailOtp,
} from '@lib/auth/send-two-factor-email-otp';

describe('isTwoFactorEmailOtpConfigured', () => {
  it('is false when either env var is missing or blank', () => {
    expect(isTwoFactorEmailOtpConfigured({})).toBe(false);
    expect(isTwoFactorEmailOtpConfigured({ SENDGRID_API_KEY: 'sg' })).toBe(false);
    expect(isTwoFactorEmailOtpConfigured({ EMAIL_FROM: 'a@b.co' })).toBe(false);
    expect(
      isTwoFactorEmailOtpConfigured({ SENDGRID_API_KEY: '  ', EMAIL_FROM: 'a@b.co' })
    ).toBe(false);
  });

  it('is true when both are set', () => {
    expect(
      isTwoFactorEmailOtpConfigured({
        SENDGRID_API_KEY: 'sg-key',
        EMAIL_FROM: 'noreply@apiome.app',
      })
    ).toBe(true);
  });
});

describe('sendTwoFactorEmailOtp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSend.mockResolvedValue([{ statusCode: 202 }]);
  });

  it('sends via SendGrid without logging the OTP', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await sendTwoFactorEmailOtp(
      { user: { email: 'user@example.com', name: 'Ada' }, otp: '654321' },
      { SENDGRID_API_KEY: 'sg-key', EMAIL_FROM: 'noreply@apiome.app' }
    );
    expect(mockSetApiKey).toHaveBeenCalledWith('sg-key');
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        from: 'noreply@apiome.app',
        subject: 'Your apiome sign-in code',
      })
    );
    const payload = mockSend.mock.calls[0][0] as { text: string; html: string };
    expect(payload.text).toContain('654321');
    expect(payload.html).toContain('654321');
    expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('654321');
    errorSpy.mockRestore();
  });

  it('throws when SendGrid is not configured', async () => {
    await expect(
      sendTwoFactorEmailOtp({ user: { email: 'a@b.co' }, otp: '111111' }, {})
    ).rejects.toThrow(/not configured/i);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
