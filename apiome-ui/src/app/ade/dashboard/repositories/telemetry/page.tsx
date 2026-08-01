'use client';

/**
 * `/ade/dashboard/repositories/telemetry` — quota & rate-limit telemetry (REPO-7.3, #2801).
 *
 * `telemetry` is a static sibling of `[id]`; Next.js matches static segments first, so this
 * route is never shadowed by the repository detail page.
 */

import { RepositoryQuotaTelemetry } from '@/app/components/ade/dashboard/repositories/RepositoryQuotaTelemetry';

export default function RepositoryQuotaTelemetryPage() {
  return <RepositoryQuotaTelemetry />;
}
