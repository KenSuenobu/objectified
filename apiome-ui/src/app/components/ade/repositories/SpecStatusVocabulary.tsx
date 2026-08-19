'use client';

/**
 * The status-vocabulary reference card (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/repository-catalog.html` — the *Status vocabulary* card,
 * which the mockup's **Notes → Adds** list introduces.
 *
 * ### Why a screen carries a legend at all
 *
 * Four of this table's seven columns are self-describing; *Status* is not. "Mapped" does not
 * say whether anything is wrong, and the answer used to live only in a `title` attribute —
 * reachable by hovering a pill with a pointer, and by nobody else. The card states all four
 * in the order that matters, so the meaning is on the page rather than under the cursor.
 *
 * The rows are {@link SPEC_CATALOG_STATUS_VOCABULARY}, which is derived from the same table
 * the rows resolve through, so the legend cannot drift from the pills it explains.
 */

import * as React from 'react';

import { Badge } from '@/app/components/ui/Badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/Card';

import {
  SPEC_CATALOG_STATUS_VOCABULARY,
  SPEC_CATALOG_VOCABULARY_TITLE,
} from './specCatalogModel';

/**
 * Render the legend.
 *
 * @returns A card listing every catalog status with the sentence that explains it.
 */
export function SpecStatusVocabulary() {
  return (
    <Card aria-label={SPEC_CATALOG_VOCABULARY_TITLE} data-testid="spec-catalog-vocabulary">
      <CardHeader>
        <CardTitle>{SPEC_CATALOG_VOCABULARY_TITLE}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="spec-vocab">
          {SPEC_CATALOG_STATUS_VOCABULARY.map((entry) => (
            <div key={entry.status} className="spec-vocab__row">
              <dt>
                <Badge status={entry.status}>{entry.label}</Badge>
              </dt>
              <dd className="spec-vocab__desc">{entry.title}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

export default SpecStatusVocabulary;
