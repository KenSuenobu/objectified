/**
 * Browser navigation helper (OLO-9.13 #5014).
 *
 * Thin wrapper around `window.location.href` so unit tests can mock navigation without
 * redefining jsdom's non-configurable `Location`.
 *
 * @param url Absolute or relative destination.
 */
export function browserNavigate(url: string): void {
  window.location.href = url;
}
