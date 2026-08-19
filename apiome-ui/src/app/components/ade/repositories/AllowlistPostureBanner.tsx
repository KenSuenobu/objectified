'use client';

/**
 * What the webhook filter is actually doing, in one sentence (HIVE-7.6, #5323).
 *
 * Authority: `docs/mockups/sources/webhook-allowlist.html` — the posture card at the top of
 * the page: a tinted tile, a headline, one explanatory sentence, and three facts.
 *
 * ### Why the posture is stated rather than left to be inferred
 *
 * Three independent switches decide whether anything is being filtered: the deployment-wide
 * setting, this workspace's own policy, and whether any provider ranges have been cached to
 * filter against. An operator reading three green ticks and one empty range table has no way
 * to combine them, and "Enforced" over an empty table is the state most likely to be misread
 * as safety. {@link allowlistPosture} combines them once; this draws the answer.
 *
 * The frame's tone is never the only signal: the headline is a phrase ("Enforced", "Bypassed
 * for this workspace"), the tile carries a glyph that differs per tone, and the three facts
 * below spell out the consequences in words.
 */

import * as React from 'react';
import { ShieldCheck, ShieldOff, TriangleAlert } from 'lucide-react';

import { Card, CardContent } from '@/app/components/ui/Card';

import {
  POSTURE_COPY,
  POSTURE_STATUS,
  POSTURE_TONE,
  type AllowlistPosture,
  type IpAllowlistResponse,
  cadenceLabel,
} from './webhookAllowlistModel';

/** The glyph each tone leads with. A tone is never alone: the headline says the same thing. */
const TONE_GLYPH = {
  ok: ShieldCheck,
  warn: TriangleAlert,
  neutral: ShieldOff,
} as const;

/**
 * One of the three consequence facts.
 *
 * @param label What the fact is about.
 * @param value What it currently is.
 * @returns The `dt`/`dd` pair.
 */
function PostureFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="wal-fact">
      <dt className="wal-fact__label">{label}</dt>
      <dd className="wal-fact__value">{value}</dd>
    </div>
  );
}

export interface AllowlistPostureBannerProps {
  /** The combined posture. */
  posture: AllowlistPosture;
  /** The allowlist projection the facts are read from. */
  data: IpAllowlistResponse;
}

/**
 * Render the posture banner. See {@link AllowlistPostureBannerProps}.
 *
 * @returns The card.
 */
export function AllowlistPostureBanner({ posture, data }: AllowlistPostureBannerProps) {
  const copy = POSTURE_COPY[posture];
  const tone = POSTURE_TONE[posture];
  const Glyph = TONE_GLYPH[tone];

  return (
    <Card
      className="wal-posture"
      aria-label="Allowlist status"
      data-testid="allowlist-posture"
      data-posture={posture}
      data-tone={tone}
      data-status={POSTURE_STATUS[posture]}
    >
      <CardContent className="wal-posture__body">
        <span className="wal-tile" data-tone={tone} aria-hidden>
          <Glyph />
        </span>

        <div className="wal-posture__text">
          <h2 className="wal-posture__title">{copy.title}</h2>
          <p className="wal-posture__desc">{copy.body}</p>

          {data.bypassReason ? (
            <p className="wal-posture__reason" data-testid="bypass-reason">
              Bypass reason: {data.bypassReason}
            </p>
          ) : null}

          <dl className="wal-facts">
            <PostureFact
              label="Provider ranges refresh"
              value={cadenceLabel(data.refreshIntervalSeconds)}
            />
            <PostureFact
              label="Empty range cache"
              value={data.strict ? 'Blocks deliveries' : 'Allows, with a warning'}
            />
            <PostureFact
              label="Trusted proxies"
              value={
                data.trustedProxyHops === 0
                  ? 'None — the socket peer is the source'
                  : `${data.trustedProxyHops} hop(s) of X-Forwarded-For`
              }
            />
          </dl>
        </div>
      </CardContent>
    </Card>
  );
}

export default AllowlistPostureBanner;
