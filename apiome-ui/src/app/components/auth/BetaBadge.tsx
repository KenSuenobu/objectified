'use client';

import * as React from 'react';
import { Badge } from '@/app/components/ui/Badge';

/**
 * BetaBadge — the deployment's "this is a beta" marker (HIVE-4.1, #5295).
 *
 * Renders only when `NEXT_PUBLIC_BETA_MODE` is set, which is the same switch the tiled
 * "BETA" watermark behind the sign-in card used to hang off (`login/BetaBackground.tsx`).
 * The signal is kept; the delivery is not. A full-screen rotated watermark competed with the
 * one decision on the page, could not follow a theme, and had to be disabled by hand before
 * a visual snapshot could be taken. A honey chip beside the mark says the same thing once,
 * where the reader is already looking — honey being brand ornament, which is exactly what
 * DESIGN.md §2 reserves it for.
 *
 * The flag is read at render time rather than at module scope so a test can set it; in the
 * browser bundle Next inlines the literal either way.
 */
export interface BetaBadgeProps {
  /** Extra classes on the chip. */
  className?: string;
}

/**
 * The beta chip, or nothing.
 *
 * @param props Optional extra classes — see {@link BetaBadgeProps}.
 * @returns The honey badge when the deployment is in beta mode, otherwise `null`.
 */
export function BetaBadge({ className }: BetaBadgeProps) {
  if (!process.env.NEXT_PUBLIC_BETA_MODE) return null;

  return (
    <Badge variant="honey" className={className}>
      BETA
    </Badge>
  );
}

export default BetaBadge;
