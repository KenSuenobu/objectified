'use client';

import * as React from 'react';
import { Check, Copy, ShieldCheck, Terminal } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { useClipboardCopy } from '@/app/hooks/useClipboardCopy';

import { apiKeyScopeUsage, API_KEY_SCOPE_REFERENCE, type ApiKeyRecord } from './apiKeysModel';

/**
 * The two reference cards under the table — HIVE-5.4 (#5307).
 *
 * Authority: `docs/mockups/workspace/api-keys.html`, the `.grid-2` section the mockup's
 * notes list under **Adds**.
 *
 * They answer the two questions the screen this replaces left the reader to find in the docs:
 * *how do I actually send this key*, and *what does each scope let a key do*. Both are
 * answered here rather than linked, because both are three lines long and the reader is
 * holding a secret they cannot look at twice.
 *
 * The scope table **counts** the tenant's own keys per scope, so it is a description of this
 * workspace rather than a copy of the documentation — which is the difference between a
 * reference card and a paragraph.
 */

/** Props for {@link ApiKeyReferenceCards}. */
export interface ApiKeyReferenceCardsProps {
  /** The tenant's keys, so the scope table can count how many hold each scope. */
  keys: readonly ApiKeyRecord[];
  /** The tenant's name, for the sentence about what a key runs as. */
  tenantName: string;
}

/**
 * The `curl` the "Use a key" card shows.
 *
 * A `diff:read` call, because that is the scope the create dialog recommends and the one a
 * CI pipeline is most likely to be wiring up.
 */
const EXAMPLE_REQUEST = `curl -X POST \\
  https://api.apiome.dev/v1/diff/ver_1a2b/ver_3c4d/classified \\
  -H "Authorization: Bearer sk_live_…" \\
  -H "Accept: application/json"`;

/**
 * The two cards.
 *
 * @param props See {@link ApiKeyReferenceCardsProps}.
 * @returns The reference section.
 */
export default function ApiKeyReferenceCards({ keys, tenantName }: ApiKeyReferenceCardsProps) {
  const { copied, copy } = useClipboardCopy();
  const usage = React.useMemo(() => apiKeyScopeUsage(keys), [keys]);

  return (
    <section className="akey-reference" data-testid="api-keys-reference">
      <article className="akey-ref-card">
        <header className="akey-ref-card__header">
          <h2 className="akey-ref-card__title">
            <Terminal aria-hidden />
            Use a key
          </h2>
          <span className="akey-ref-card__note">Bearer token over HTTPS</span>
        </header>
        <div className="akey-ref-card__body">
          <div className="akey-code-wrap">
            <pre className="akey-code mono" data-testid="api-keys-example-request">
              <code>{EXAMPLE_REQUEST}</code>
            </pre>
            <Button
              variant="outline"
              size="sm"
              className="akey-code-copy"
              aria-label={copied ? 'Copied the example request' : 'Copy the example request'}
              onClick={() => void copy(EXAMPLE_REQUEST)}
            >
              {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <p className="akey-ref-card__desc">
            Keys are tenant-scoped: every call runs as <strong>{tenantName}</strong>. Rotate by
            creating a new key, switching the pipeline over, then deleting the old one.
          </p>
        </div>
      </article>

      <article className="akey-ref-card">
        <header className="akey-ref-card__header">
          <h2 className="akey-ref-card__title">
            <ShieldCheck aria-hidden />
            Scope reference
          </h2>
          <Badge variant="outline">{API_KEY_SCOPE_REFERENCE.length} scopes</Badge>
        </header>
        <div className="akey-ref-card__body akey-ref-card__body--flush">
          <table className="akey-scope-table">
            <caption className="sr-only">
              What each API key scope allows, and how many of this tenant&apos;s keys hold it
            </caption>
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col">Allows</th>
                <th scope="col" className="akey-scope-table__count">
                  Keys
                </th>
              </tr>
            </thead>
            <tbody>
              {API_KEY_SCOPE_REFERENCE.map((entry) => (
                <tr key={entry.scope}>
                  <td>
                    <Badge mono variant={entry.full ? 'neutral' : 'accent'}>
                      {entry.scope}
                    </Badge>
                  </td>
                  <td className="akey-scope-table__allows">{entry.allows}</td>
                  <td
                    className="akey-scope-table__count mono"
                    data-testid={`api-key-scope-count-${entry.full ? 'full' : entry.scope}`}
                  >
                    {usage[entry.scope] ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
