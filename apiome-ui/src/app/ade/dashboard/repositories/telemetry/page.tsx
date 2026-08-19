'use client';

/**
 * `/ade/dashboard/repositories/telemetry` — quota & rate-limit telemetry
 * (REPO-7.3, #2801; redesigned HIVE-7.6, #5323).
 *
 * `telemetry` is a static sibling of `[id]`; Next.js matches static segments first, so this
 * route is never shadowed by the repository detail page.
 */

import { QuotaTelemetryClient } from './QuotaTelemetryClient';

export default function RepositoryQuotaTelemetryPage() {
  return <QuotaTelemetryClient />;
}
