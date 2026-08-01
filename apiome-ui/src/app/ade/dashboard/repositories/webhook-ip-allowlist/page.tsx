'use client';

/**
 * `/ade/dashboard/repositories/webhook-ip-allowlist` — source-IP allowlist (REPO-7.6, #2804).
 *
 * `webhook-ip-allowlist` is a static sibling of `[id]`; Next.js matches static segments first,
 * so this route is never shadowed by the repository detail page.
 */

import { RepositoryWebhookIpAllowlist } from '@/app/components/ade/dashboard/repositories/RepositoryWebhookIpAllowlist';

export default function RepositoryWebhookIpAllowlistPage() {
  return <RepositoryWebhookIpAllowlist />;
}
