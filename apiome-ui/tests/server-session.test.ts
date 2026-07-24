/**
 * Server reader tests for `lib/auth/server-session.ts` (OLO-10.12 #5007; Better-Auth-only since the
 * OLO-10.14 cutover #5009).
 *
 * `getAuthSession()` is the single server-side session read for ~106 routes + the route guards. It
 * reads the Better Auth database session (`auth.api.getSession`) and maps it onto the app contract via
 * `toAppSessionUser`. These tests mock the lazily-imported deps and assert the read + mapping.
 *
 * NOTE: `@lib/auth/server-session` resolves to the REAL module here (the `^@lib/(.*)$` mapper wins over
 * the `server-session` mock mapper, which only catches relative imports), so we exercise the real
 * read and mock its lazily-imported deps instead.
 */

const mockGetSession = jest.fn();
const mockToAppSessionUser = jest.fn();
const mockHeaders = jest.fn(async () => new Headers());

jest.mock('@lib/auth/auth', () => ({ auth: { api: { getSession: mockGetSession } } }));
jest.mock('@lib/auth/better-auth-session-shape', () => ({ toAppSessionUser: mockToAppSessionUser }));
jest.mock('next/headers', () => ({ headers: mockHeaders }));

import { getAuthSession } from '@lib/auth/server-session';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getAuthSession', () => {
  it('reads the Better Auth session and maps it to the app contract', async () => {
    const expiresAt = new Date('2030-01-02T03:04:05.000Z');
    mockGetSession.mockResolvedValue({ user: { id: 'u1', email: 'a@b.co' }, session: { expiresAt } });
    mockToAppSessionUser.mockResolvedValue({ user_id: 'u1', email: 'a@b.co', current_tenant_id: 't1' });

    const session = await getAuthSession();

    expect(mockGetSession).toHaveBeenCalledWith({ headers: expect.any(Headers) });
    expect(mockToAppSessionUser).toHaveBeenCalledWith({ id: 'u1', email: 'a@b.co' });
    expect(session).toEqual({
      user: { user_id: 'u1', email: 'a@b.co', current_tenant_id: 't1' },
      expires: '2030-01-02T03:04:05.000Z',
    });
  });

  it('returns null when there is no Better Auth session', async () => {
    mockGetSession.mockResolvedValue(null);

    expect(await getAuthSession()).toBeNull();
    expect(mockToAppSessionUser).not.toHaveBeenCalled();
  });
});
