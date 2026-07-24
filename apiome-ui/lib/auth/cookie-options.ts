/** Where a login lands when no (valid) callbackUrl was requested. */
export const DEFAULT_LOGIN_LANDING = '/ade';

const TRUSTED_URL_ENVS = [
  'NEXTAUTH_URL',
  'NEXT_PUBLIC_STUDIO_URL',
  'NEXT_PUBLIC_MAIN_APP_URL',
] as const;

function registrableDomain(hostname: string): string | null {
  if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1') {
    return null;
  }
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join('.');
}

function normalizeCookieDomain(domain: string): string {
  const trimmed = domain.trim();
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function tryOrigin(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
}

/** Origins of the main app, studio, and NextAuth base — always trusted callback targets. */
export function trustedAppOrigins(): Set<string> {
  const origins = new Set<string>();
  for (const key of TRUSTED_URL_ENVS) {
    const origin = tryOrigin(process.env[key]);
    if (origin) origins.add(origin);
  }
  return origins;
}

function trustedRegistrableDomains(): Set<string> {
  const domains = new Set<string>();
  for (const key of TRUSTED_URL_ENVS) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    try {
      const domain = registrableDomain(new URL(raw).hostname);
      if (domain) domains.add(domain);
    } catch {
      // ignore malformed env
    }
  }
  return domains;
}

function inferCookieDomain(): string | undefined {
  if (process.env.NODE_ENV !== 'production') return undefined;
  for (const key of TRUSTED_URL_ENVS) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    try {
      const domain = registrableDomain(new URL(raw).hostname);
      if (domain) return normalizeCookieDomain(domain);
    } catch {
      // ignore malformed env
    }
  }
  return undefined;
}

/** Parent domain for shared session cookies, or undefined on localhost / dev. */
export function getSharedCookieDomain(): string | undefined {
  if (process.env.NODE_ENV !== 'production') return undefined;

  const configured = process.env.NEXTAUTH_COOKIE_DOMAIN?.trim();
  const inferred = inferCookieDomain();

  if (configured) {
    const normalized = normalizeCookieDomain(configured);
    // A stale .apiome.app cookie domain on an apiome.dev deploy is ignored by
    // browsers and breaks both session sharing and callback validation.
    if (inferred && normalized.slice(1) !== inferred.slice(1)) {
      return inferred;
    }
    return normalized;
  }

  return inferred;
}

/**
 * True when a callback value is a same-origin relative path that a browser
 * cannot reinterpret as an absolute URL.
 *
 * Rejects protocol-relative forms (`//evil.com`) and their backslash
 * equivalents (`/\evil.com`) — WHATWG URL parsing treats `\` as `/` in
 * http(s) URLs, so a redirect to `/\evil.com` lands on `https://evil.com/`.
 * Backslashes are rejected anywhere in the value; no legitimate app path
 * contains one.
 *
 * @param url The raw callback value to test.
 * @returns Whether the value is safe to use as a same-origin redirect path.
 */
export function isSafeRelativeCallbackPath(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.includes('\\');
}

function hostnameMatchesCookieDomain(hostname: string, cookieDomain: string): boolean {
  const suffix = normalizeCookieDomain(cookieDomain);
  const bare = suffix.slice(1);
  return hostname === bare || hostname.endsWith(suffix);
}

function hostnameMatchesTrustedDeployment(hostname: string): boolean {
  const targetDomain = registrableDomain(hostname);
  if (!targetDomain) return false;
  return trustedRegistrableDomains().has(targetDomain);
}

/**
 * Rewrite a stale studio hostname baked into an older bundle (e.g.
 * studio.apiome.dev) to the configured studio origin (suite.apiome.dev).
 */
export function canonicalizeCrossAppCallback(url: string): string {
  if (url.startsWith('/')) return url;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return url;
  }

  const mainOrigin = tryOrigin(process.env.NEXTAUTH_URL);
  const studioOrigin = tryOrigin(process.env.NEXT_PUBLIC_STUDIO_URL);
  const targetDomain = registrableDomain(target.hostname);
  if (!targetDomain) return url;

  if (studioOrigin) {
    try {
      const canonical = new URL(studioOrigin);
      if (
        registrableDomain(canonical.hostname) === targetDomain &&
        target.origin !== canonical.origin
      ) {
        return `${canonical.origin}${target.pathname}${target.search}${target.hash}`;
      }
    } catch {
      // ignore malformed studio URL
    }
  }

  // Fall back to any other trusted non-main origin on the same registrable domain.
  if (target.origin !== mainOrigin) {
    for (const origin of trustedAppOrigins()) {
      if (origin === mainOrigin) continue;
      try {
        if (registrableDomain(new URL(origin).hostname) === targetDomain) {
          const canonical = new URL(origin);
          return `${canonical.origin}${target.pathname}${target.search}${target.hash}`;
        }
      } catch {
        // ignore malformed trusted origin
      }
    }
  }

  return url;
}

/**
 * A login callback URL may leave this origin only for hosts covered by the
 * shared session cookie (e.g. suite.apiome.dev when the cookie domain is
 * .apiome.dev) or configured app URLs — anything else is an open-redirect vector.
 */
export function isAllowedCallbackUrl(url: string, baseUrl?: string): boolean {
  if (url.startsWith('/')) return isSafeRelativeCallbackPath(url);

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }

  if (baseUrl) {
    try {
      if (target.origin === new URL(baseUrl).origin) return true;
    } catch {
      // Malformed baseUrl — fall through.
    }
  }

  if (trustedAppOrigins().has(target.origin)) {
    return process.env.NODE_ENV !== 'production' || target.protocol === 'https:';
  }

  if (process.env.NODE_ENV !== 'production') {
    return target.hostname === 'localhost' || target.hostname === '127.0.0.1';
  }

  if (target.protocol !== 'https:') return false;

  if (hostnameMatchesTrustedDeployment(target.hostname)) {
    return true;
  }

  const cookieDomain = getSharedCookieDomain();
  if (!cookieDomain) return false;
  return hostnameMatchesCookieDomain(target.hostname, cookieDomain);
}

/** Validated callback URL for the login flow, or the default landing page. */
export function resolveCallbackUrl(url: string | undefined | null, baseUrl?: string): string {
  const trimmed = url?.trim();
  if (!trimmed) return DEFAULT_LOGIN_LANDING;

  const canonical = canonicalizeCrossAppCallback(trimmed);
  return isAllowedCallbackUrl(canonical, baseUrl ?? process.env.NEXTAUTH_URL)
    ? canonical
    : DEFAULT_LOGIN_LANDING;
}
