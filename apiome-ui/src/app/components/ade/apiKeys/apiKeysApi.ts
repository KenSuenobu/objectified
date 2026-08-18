/**
 * The API keys transport — HIVE-5.4 (#5307).
 *
 * `lib/db/helper` is a `'use server'` module, so every one of these calls is a server action
 * rather than a `fetch`. That is how this screen has always read and written keys, and this
 * ticket is a redesign rather than a migration — what changes here is only the *shape* the
 * calls have when they reach a component.
 *
 * ### Why the wrapper exists
 *
 * The helpers answer in JSON strings carrying a `{ success, error }` envelope, which meant
 * every call site did the same four things: `JSON.parse`, check `success`, pull `error` out
 * with a fallback, and `console.error` the failure into a place no reader can see. Two of
 * the old page's three writes silently did nothing when they failed — the row simply did not
 * change.
 *
 * Everything below therefore **throws** on failure, with the server's own message, and
 * returns a real value on success. Failure then has exactly one shape for the page to catch
 * and show in the dialog the reader is already looking at.
 */

import {
  createApiKey,
  deleteApiKey,
  getApiKeysForTenant,
  toggleApiKeyStatus,
} from '../../../../../lib/db/helper';

import type { ApiKeyRecord } from './apiKeysModel';

/** What `createApiKey` returns on success — the one and only sight of the secret. */
export interface CreatedApiKey {
  /** The new key's id. */
  id: string;
  /** The plaintext secret. Held only until the reveal dialog closes. */
  secret: string;
  /** The stored prefix, which is what the list shows from now on. */
  keyPrefix: string;
  /** The scopes the server recorded. */
  scopes: string[];
}

/**
 * Read one JSON envelope, or throw its error.
 *
 * @param raw The helper's JSON string.
 * @param fallback What to say when the failure carried no message.
 * @returns The parsed envelope.
 * @throws Error carrying the server's message when `success` is false or the body is not JSON.
 */
function unwrap<T extends { success?: boolean; error?: string }>(
  raw: string,
  fallback: string
): T {
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    throw new Error(fallback);
  }
  if (parsed?.success === false) {
    throw new Error(parsed.error || fallback);
  }
  return parsed;
}

/**
 * Every key of a tenant, newest first.
 *
 * The helper swallows its own read failures and answers `[]`, so an empty list here means
 * "no keys" *or* "the read failed" — a distinction this transport cannot restore and does
 * not pretend to. What it can do is refuse to guess: a body that is not an array throws
 * rather than becoming an empty table that reads as "no keys yet".
 *
 * @param tenantId The tenant whose keys to read.
 * @returns The keys.
 * @throws Error when the response is not a list.
 */
export async function fetchApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
  const raw = await getApiKeysForTenant(tenantId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Failed to load API keys');
  }
  if (!Array.isArray(parsed)) throw new Error('Failed to load API keys');
  return parsed as ApiKeyRecord[];
}

/**
 * Create a key, and hand back the secret.
 *
 * @param input.tenantId The tenant the key acts as.
 * @param input.name Its name.
 * @param input.description What it is for.
 * @param input.expiresInDays Days until expiry, or `null` for none.
 * @param input.scopes The scope strings from the chosen preset.
 * @returns The secret and the key's identifiers.
 * @throws Error carrying the server's message.
 */
export async function createApiKeyForTenant(input: {
  tenantId: string;
  name: string;
  description: string;
  expiresInDays: number | null;
  scopes: readonly string[];
}): Promise<CreatedApiKey> {
  const raw = await createApiKey(
    input.tenantId,
    input.name,
    input.description,
    input.expiresInDays,
    [...input.scopes]
  );
  const body = unwrap<{
    success?: boolean;
    error?: string;
    apiKey?: string;
    id?: string;
    keyPrefix?: string;
    scopes?: string[];
  }>(raw, 'Failed to create API key');

  if (!body.apiKey) throw new Error('The server created the key but returned no secret');

  return {
    id: body.id ?? '',
    secret: body.apiKey,
    keyPrefix: body.keyPrefix ?? '',
    scopes: body.scopes ?? [...input.scopes],
  };
}

/**
 * Delete a key. The row is soft-deleted, so the audit trail keeps it.
 *
 * @param apiKeyId The key.
 * @throws Error carrying the server's message.
 */
export async function removeApiKey(apiKeyId: string): Promise<void> {
  unwrap(await deleteApiKey(apiKeyId), 'Failed to delete API key');
}

/**
 * Turn a key on or off.
 *
 * @param apiKeyId The key.
 * @param enabled The state to move it to.
 * @throws Error carrying the server's message.
 */
export async function setApiKeyEnabled(apiKeyId: string, enabled: boolean): Promise<void> {
  unwrap(await toggleApiKeyStatus(apiKeyId, enabled), 'Failed to update API key');
}
