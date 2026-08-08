/**
 * Try It body transport encoding — SIM-3.3 (#4449).
 *
 * The relay envelope (and the direct-fetch path in `send.ts`) carries response bodies as JSON
 * strings, which cannot represent arbitrary bytes: decoding a binary payload (an image, a PDF)
 * as UTF-8 is lossy, so the response viewer could neither render images nor download exact
 * bytes. These helpers make the transport binary-safe:
 *
 * - Bodies whose bytes are valid UTF-8 (and free of NUL characters) travel as plain text
 *   (`bodyEncoding: 'text'`) — the overwhelmingly common case, with zero overhead.
 * - Everything else travels base64-encoded (`bodyEncoding: 'base64'`), so the viewer can
 *   recover the exact bytes for inline image rendering and byte-exact downloads.
 *
 * Kept free of Node/DOM imports (no `Buffer`, no `atob`/`btoa`) so it is usable from both the
 * relay (server) and the browser, and unit-testable under the browse Vitest setup.
 */

/** How a response body string is encoded in the transport envelope. */
export type BodyEncoding = 'text' | 'base64';

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup table for {@link base64ToBytes}; -1 marks invalid characters. */
const BASE64_REVERSE: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** The NUL character — its presence marks a "text" body as binary in practice. */
const NUL = String.fromCharCode(0);

/**
 * Encode bytes as standard base64 (RFC 4648, with `=` padding).
 *
 * @param bytes - The raw bytes to encode.
 * @returns The base64 string (empty string for empty input).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    parts.push(
      BASE64_ALPHABET[(triple >> 18) & 63],
      BASE64_ALPHABET[(triple >> 12) & 63],
      i + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : '=',
      i + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : '='
    );
  }
  return parts.join('');
}

/**
 * Decode a standard base64 string back to bytes. Whitespace is ignored; invalid characters and
 * malformed lengths yield an empty array rather than throwing (a hostile envelope must not
 * crash the viewer).
 *
 * @param base64 - The base64 string to decode.
 * @returns The decoded bytes, or an empty array when the input is not valid base64.
 */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[\s=]+$/, '').replace(/\s+/g, '');
  const remainder = clean.length % 4;
  if (remainder === 1) return new Uint8Array(0);
  const outLength = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(outLength);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    const value = code < 128 ? BASE64_REVERSE[code] : -1;
    if (value === -1) return new Uint8Array(0);
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, offset);
}

/**
 * Decide how a response body should travel in the envelope: plain text when the bytes are
 * valid, NUL-free UTF-8; base64 otherwise.
 *
 * @param bytes - The raw response-body bytes.
 * @param options.trimIncompleteTrailing - Set when the bytes were cut off mid-stream (the
 *   relay's 1MB cap): a text body truncated inside a multi-byte codepoint would otherwise fail
 *   strict decoding and flip to base64, so up to 3 trailing bytes of an incomplete final
 *   sequence are dropped to keep it viewable as text.
 * @returns The encoded body string and which encoding was used.
 */
export function encodeBodyBytes(
  bytes: Uint8Array,
  options: { trimIncompleteTrailing?: boolean } = {}
): { body: string; bodyEncoding: BodyEncoding } {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const attempts = options.trimIncompleteTrailing ? Math.min(4, bytes.length + 1) : 1;
  for (let trim = 0; trim < attempts; trim++) {
    try {
      const text = decoder.decode(trim === 0 ? bytes : bytes.subarray(0, bytes.length - trim));
      if (!text.includes(NUL)) {
        return { body: text, bodyEncoding: 'text' };
      }
      break; // NUL bytes mean binary content — trimming more will not change that.
    } catch {
      // Not valid UTF-8 at this length — try trimming one more trailing byte, if allowed.
    }
  }
  return { body: bytesToBase64(bytes), bodyEncoding: 'base64' };
}

/**
 * Recover the exact body bytes from an envelope body string.
 *
 * @param body - The envelope body string (`bodyText` on a `TryItResult`).
 * @param encoding - Which encoding the string uses.
 * @returns The raw body bytes.
 */
export function decodeBodyBytes(body: string, encoding: BodyEncoding): Uint8Array {
  return encoding === 'base64' ? base64ToBytes(body) : new TextEncoder().encode(body);
}
