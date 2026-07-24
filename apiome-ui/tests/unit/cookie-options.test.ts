import {
  canonicalizeCrossAppCallback,
  getSharedCookieDomain,
  isAllowedCallbackUrl,
  isSafeRelativeCallbackPath,
  resolveCallbackUrl,
} from '@lib/auth/cookie-options';

describe('cookie-options', () => {
  const env = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...env };
  });

  afterAll(() => {
    process.env = env;
  });

  it('infers the shared cookie domain from NEXTAUTH_URL in production', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
    process.env.NEXTAUTH_URL = 'https://main.apiome.dev';

    expect(getSharedCookieDomain()).toBe('.apiome.dev');
  });

  it('allows studio callbacks when the studio URL is configured', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
    process.env.NEXTAUTH_URL = 'https://main.apiome.dev';
    process.env.NEXT_PUBLIC_STUDIO_URL = 'https://suite.apiome.dev';

    const callback = 'https://suite.apiome.dev/editor';
    expect(isAllowedCallbackUrl(callback, process.env.NEXTAUTH_URL)).toBe(true);
    expect(resolveCallbackUrl(callback)).toBe(callback);
  });

  it('allows studio callbacks from the inferred cookie domain without an explicit studio env', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
    delete process.env.NEXT_PUBLIC_STUDIO_URL;
    process.env.NEXTAUTH_URL = 'https://main.apiome.dev';

    const callback = 'https://suite.apiome.dev/editor';
    expect(resolveCallbackUrl(callback)).toBe(callback);
  });

  it('rejects callbacks outside the deployment domain', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
    process.env.NEXTAUTH_URL = 'https://main.apiome.dev';

    expect(resolveCallbackUrl('https://evil.example/phish')).toBe('/ade');
  });

  it('ignores a stale cookie domain that does not match the deployment hostnames', () => {
    process.env.NODE_ENV = 'production';
    process.env.NEXTAUTH_COOKIE_DOMAIN = '.apiome.app';
    process.env.NEXTAUTH_URL = 'https://main.apiome.dev';

    expect(getSharedCookieDomain()).toBe('.apiome.dev');
    expect(resolveCallbackUrl('https://suite.apiome.dev/editor')).toBe(
      'https://suite.apiome.dev/editor'
    );
  });

  it('rewrites stale studio hostnames to the configured studio origin', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.NEXTAUTH_COOKIE_DOMAIN;
    process.env.NEXTAUTH_URL = 'https://main.apiome.dev';
    process.env.NEXT_PUBLIC_STUDIO_URL = 'https://suite.apiome.dev';

    const stale = 'https://studio.apiome.dev/editor';
    expect(canonicalizeCrossAppCallback(stale)).toBe('https://suite.apiome.dev/editor');
    expect(resolveCallbackUrl(stale)).toBe('https://suite.apiome.dev/editor');
  });

  // Open-redirect hardening (OLO-3.4, #4202): a callbackUrl must never be able
  // to leave the deployment. Browsers parse `\` as `/` in http(s) URLs, so a
  // redirect to `/\evil.com` resolves to https://evil.com/ — every relative
  // form that a browser could reinterpret as cross-origin must be rejected.
  describe('open-redirect rejection', () => {
    it('accepts ordinary same-origin relative paths', () => {
      expect(isSafeRelativeCallbackPath('/ade')).toBe(true);
      expect(isSafeRelativeCallbackPath('/ade/dashboard/projects?tab=all#top')).toBe(true);
      expect(isAllowedCallbackUrl('/ade/dashboard/projects?tab=all')).toBe(true);
    });

    it('rejects protocol-relative URLs', () => {
      expect(isSafeRelativeCallbackPath('//evil.example')).toBe(false);
      expect(isAllowedCallbackUrl('//evil.example')).toBe(false);
      expect(resolveCallbackUrl('//evil.example')).toBe('/ade');
    });

    it('rejects backslash protocol-relative equivalents', () => {
      for (const vector of ['/\\evil.example', '/\\/evil.example', '\\/evil.example', '\\\\evil.example']) {
        expect(isSafeRelativeCallbackPath(vector)).toBe(false);
        expect(isAllowedCallbackUrl(vector)).toBe(false);
        expect(resolveCallbackUrl(vector)).toBe('/ade');
      }
    });

    it('rejects backslashes anywhere in a relative path', () => {
      expect(isSafeRelativeCallbackPath('/ade/..\\..\\evil')).toBe(false);
      expect(isAllowedCallbackUrl('/ade/..\\..\\evil')).toBe(false);
    });

    it('rejects non-relative non-URL junk', () => {
      expect(isAllowedCallbackUrl('javascript:alert(1)')).toBe(false);
      expect(resolveCallbackUrl('javascript:alert(1)')).toBe('/ade');
      expect(resolveCallbackUrl('   ')).toBe('/ade');
      expect(resolveCallbackUrl(null)).toBe('/ade');
      expect(resolveCallbackUrl(undefined)).toBe('/ade');
    });

    it('rejects external absolute URLs in production regardless of scheme', () => {
      process.env.NODE_ENV = 'production';
      process.env.NEXTAUTH_URL = 'https://main.apiome.dev';

      expect(resolveCallbackUrl('https://evil.example/phish')).toBe('/ade');
      expect(resolveCallbackUrl('http://main.apiome.dev.evil.example/')).toBe('/ade');
    });
  });

  it('does not apply a production cookie domain on localhost', () => {
    process.env.NODE_ENV = 'development';
    process.env.NEXTAUTH_COOKIE_DOMAIN = '.apiome.dev';
    process.env.NEXTAUTH_URL = 'http://localhost:3000';

    expect(getSharedCookieDomain()).toBeUndefined();
  });
});
