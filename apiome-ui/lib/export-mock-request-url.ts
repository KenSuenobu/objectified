/**
 * Resolve a browser-supplied operation path into a URL under one mock instance (MFX-44.5, #4371).
 *
 * The Export Studio's try-it control sends `{ method, path }` to `/api/export/mock/{id}/try`, and
 * that route has to turn the path into an absolute URL it will call. The path comes from the
 * browser, so it is the one string in this feature that must never be concatenated raw.
 *
 * Kept here — pure, dependency-free, outside the route module — so it can be exercised directly
 * against the shapes it exists to neutralize (traversal, protocol-relative and absolute origins)
 * without standing up the Next.js request runtime.
 */

/**
 * Build the absolute URL for one try-it request.
 *
 * `path` is parsed against a throw-away origin first, which makes the URL parser — not this code —
 * responsible for normalising `..` segments, protocol-relative `//host` forms and any embedded
 * origin. Only the resulting `pathname` and `search` survive, and both are appended to a base this
 * function builds itself, so the returned URL can never leave `{restBaseUrl}/mock/{mockId}`.
 *
 * @param restBaseUrl The REST API base URL (already including its `/v1` segment).
 * @param mockId The mock instance id; percent-encoded into the path.
 * @param path The operation path relative to the mock base URL (e.g. `/widgets/42?limit=2`).
 * @returns The absolute URL to call.
 */
export function resolveMockRequestUrl(restBaseUrl: string, mockId: string, path: string): URL {
  const base = `${restBaseUrl.replace(/\/$/, '')}/mock/${encodeURIComponent(mockId)}`;
  const relative = new URL(path || '/', 'http://mock.invalid');
  const target = new URL(base);
  // `relative.pathname` always begins with `/` and is already normalised, so this appends exactly
  // one path-segment group under the instance's own prefix — and nothing above it.
  target.pathname = `${target.pathname}${relative.pathname === '/' ? '' : relative.pathname}`;
  target.search = relative.search;
  return target;
}
