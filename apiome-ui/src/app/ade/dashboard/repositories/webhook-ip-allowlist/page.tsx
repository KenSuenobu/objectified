'use client';

/**
 * `/ade/dashboard/repositories/webhook-ip-allowlist` — the source-IP allowlist
 * (REPO-7.6, #2804; redesigned HIVE-7.6, #5323).
 *
 * `webhook-ip-allowlist` is a static sibling of `[id]`; Next.js matches static segments first,
 * so this route is never shadowed by the repository detail page.
 */

import { WebhookAllowlistClient } from './WebhookAllowlistClient';

export default function RepositoryWebhookIpAllowlistPage() {
  return <WebhookAllowlistClient />;
}
