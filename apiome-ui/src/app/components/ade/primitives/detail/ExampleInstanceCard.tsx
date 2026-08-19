'use client';

/**
 * The generated example instance (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html` §Example instance — the document, and
 * the line stating how it was chosen.
 *
 * The block was `bg-gray-900 dark:bg-black/40` with `text-gray-200` code: a box that stayed
 * black on Whiteboard and Solarized alike. It reuses `.prm-code` — the light inset well
 * HIVE-6.5 introduced for the resolver's `$ref` example — for the same reason and with the same
 * measurements behind it (`--fg` on `--bg-inset` clears AA in all nine appearances).
 *
 * The card renders only when `buildExampleInstance` produced something: a type whose only
 * content is an unresolvable `$ref` has no example to show, and an empty well is worse than no
 * card at all.
 */

import * as React from 'react';
import { FileJson2 } from 'lucide-react';

import { Card, CardBody, CardHeader } from '@/app/components/ui/Card';

import { EXAMPLE_PROVENANCE } from './primitiveDetailView';

export interface ExampleInstanceCardProps {
  /** The generated instance. The caller has already checked it is not `null`. */
  instance: unknown;
}

/**
 * Render the card. See {@link ExampleInstanceCardProps}.
 *
 * @returns The head and the example, pretty-printed in the inset well.
 */
export default function ExampleInstanceCard({ instance }: ExampleInstanceCardProps) {
  return (
    <Card data-testid="primitive-detail-example">
      <CardHeader className="pd-head">
        <h2 className="prm-panel-head__title">
          <FileJson2 aria-hidden />
          Example instance
        </h2>
        <span className="prm-hint">{EXAMPLE_PROVENANCE}</span>
      </CardHeader>
      <CardBody>
        <pre className="prm-code">{JSON.stringify(instance, null, 2)}</pre>
      </CardBody>
    </Card>
  );
}
