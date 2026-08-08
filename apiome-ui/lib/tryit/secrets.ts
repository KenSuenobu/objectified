/**
 * Secret placeholder helpers for Try It code snippets — SIM-3.5 (#4451), SIM-3.6 (#4452).
 *
 * Snippet generators never emit raw credential values. This module infers likely secrets from
 * header and query names (and accepts explicit placeholders from SIM-3.6 auth helpers) so generated
 * curl / fetch / httpx samples use tokens like `$API_KEY` instead.
 */

/** Lowercase header name or `query:<paramName>` → placeholder token (e.g. `$API_KEY`). */
export type SecretPlaceholderMap = Record<string, string>;

const SECRET_HEADER_NAMES =
  /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token)$/i;

const SECRET_QUERY_NAMES = /^(api_key|apikey|access_token|token|key)$/i;

/**
 * Placeholder token for a header that carries credentials.
 *
 * @param name - The header name as declared in the spec or entered by the user.
 */
export function placeholderForHeader(name: string): string {
  if (/^authorization$/i.test(name)) return '$AUTHORIZATION';
  if (/api.?key/i.test(name)) return '$API_KEY';
  if (/token/i.test(name)) return '$ACCESS_TOKEN';
  return '$SECRET';
}

/**
 * Placeholder token for a query parameter that carries credentials.
 *
 * @param name - The query parameter name.
 */
export function placeholderForQueryParam(name: string): string {
  if (/api.?key/i.test(name)) return '$API_KEY';
  if (/token/i.test(name)) return '$ACCESS_TOKEN';
  return '$SECRET';
}

/**
 * Infer secret placeholders from a composed request's headers and URL query string.
 *
 * Explicit entries from SIM-3.6 auth helpers should be merged on top of this map by callers.
 *
 * @param url - The absolute request URL (may include query parameters).
 * @param headers - Request headers keyed by name.
 */
export function inferSecretPlaceholders(
  url: string,
  headers: Record<string, string>
): SecretPlaceholderMap {
  const map: SecretPlaceholderMap = {};
  for (const name of Object.keys(headers)) {
    if (SECRET_HEADER_NAMES.test(name)) {
      map[name.toLowerCase()] = placeholderForHeader(name);
    }
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.forEach((value, name) => {
      if (value !== '' && SECRET_QUERY_NAMES.test(name)) {
        map[`query:${name}`] = placeholderForQueryParam(name);
      }
    });
  } catch {
    // Leave query placeholders empty when the URL is not parseable.
  }
  return map;
}

/**
 * Replace credential values in a composed request with placeholder tokens.
 *
 * @param request - The raw composed request (actual header/query values).
 * @param placeholders - Map from {@link inferSecretPlaceholders} plus any explicit auth-helper entries.
 */
export function applySecretPlaceholders<T extends { url: string; headers: Record<string, string> }>(
  request: T,
  placeholders: SecretPlaceholderMap
): T {
  if (Object.keys(placeholders).length === 0) return request;

  const headers = { ...request.headers };
  for (const [name, value] of Object.entries(headers)) {
    const token = placeholders[name.toLowerCase()];
    if (token) headers[name] = token;
  }

  let url = request.url;
  try {
    const parsed = new URL(url);
    let changed = false;
    for (const [key, token] of Object.entries(placeholders)) {
      if (!key.startsWith('query:')) continue;
      const paramName = key.slice('query:'.length);
      if (parsed.searchParams.has(paramName)) {
        parsed.searchParams.set(paramName, token);
        changed = true;
      }
    }
    if (changed) url = parsed.toString();
  } catch {
    // Keep the original URL when it cannot be parsed.
  }

  return { ...request, url, headers };
}
