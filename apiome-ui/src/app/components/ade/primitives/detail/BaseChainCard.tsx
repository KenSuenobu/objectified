'use client';

/**
 * The base chain of the primitive-detail page (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html` §Base chain — this type, then one step
 * per relative `$ref`, with the unresolved step marked.
 *
 * ### Marked, not inked
 *
 * The mockup writes an unresolved step in `--warn` text. `--warn` measures 2.82:1 on the surface
 * in Solarized — the measurement HIVE-6.5 recorded — so the tone here lands on the rail and the
 * dot, which are graphics at 3:1, and the step *says* the word `unresolved` beside them. The
 * state therefore survives both the contrast floor and a reader who cannot see the hue.
 *
 * The head node is this type itself, so it never links anywhere; a hop links only when the API
 * annotated the edge with a target id.
 */

import * as React from 'react';
import Link from 'next/link';
import { CornerDownRight, GitCommitVertical } from 'lucide-react';

import { Card, CardBody, CardHeader } from '@/app/components/ui/Card';
import {
  baseChainNodeHref,
  baseChainNodeLabel,
  type BaseChainNode,
} from '@/app/ade/dashboard/primitives/primitiveDetailModel';
import { cn } from '@lib/utils';

import { chainStepMeta, chainStepState } from './primitiveDetailView';

export interface BaseChainCardProps {
  /** The chain, head node first. */
  chain: readonly BaseChainNode[];
  /** The type's own JSON type, for the head node's quiet line. */
  category: string;
}

/**
 * Render the card. See {@link BaseChainCardProps}.
 *
 * @returns The ordered list of steps.
 */
export default function BaseChainCard({ chain, category }: BaseChainCardProps) {
  return (
    <Card data-testid="primitive-detail-base-chain">
      <CardHeader className="pd-head">
        <h2 className="prm-panel-head__title">
          <GitCommitVertical aria-hidden />
          Base chain
        </h2>
        <span className="prm-panel-head__sub">
          Relative-ref chain down to a primitive · click a resolved step to open it.
        </span>
      </CardHeader>
      <CardBody>
        <ol className="pd-chain">
          {chain.map((node, index) => {
            const state = chainStepState(node);
            const href = baseChainNodeHref(node);
            return (
              <li
                key={`${node.label}-${index}`}
                data-status={state}
                className={cn('pd-chain__step', node.kind === 'ref' && 'pd-chain__step--ref')}
              >
                {node.kind === 'ref' ? (
                  <CornerDownRight aria-hidden className="pd-chain__glyph" />
                ) : (
                  <span aria-hidden className="pd-chain__dot" />
                )}
                <span className="pd-chain__body">
                  {href ? (
                    <Link
                      href={href}
                      data-testid={`base-chain-link-${index}`}
                      title={baseChainNodeLabel(node)}
                      aria-label={baseChainNodeLabel(node)}
                      className="pd-chain__label prm-ref-link mono"
                    >
                      {node.label}
                    </Link>
                  ) : (
                    <span className="pd-chain__label mono">{node.label}</span>
                  )}
                  <span className="pd-chain__meta mono">{chainStepMeta(node, category)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </CardBody>
    </Card>
  );
}
