'use client';

import * as React from 'react';
import type { CSSProperties } from 'react';
import { BrandMark } from '@/app/components/brand';
import { BetaBadge } from '@/app/components/auth/BetaBadge';
import { FormatPill } from '@/app/components/ui/catalog/FormatPill';

/**
 * The sign-in page's brand panel (HIVE-4.1, #5295).
 *
 * Authority: `docs/mockups/auth/login.html` § brand panel.
 *
 * The half of the front door that is not a decision: the bee lock-up, what Apiome is in one
 * line, what it does in one sentence, and the formats it speaks — the last as the app's own
 * format pills, so the OpenAPI a visitor meets here is the same blue they will meet in the
 * catalog. `AuthShell` supplies the hex canvas and the honey glow around it, and hides the
 * whole panel below 1000 px.
 */

/** One floating format chip: a registry format id, and where it sits in the drift. */
interface FormatChip {
  /** Catalog format registry id — resolves to the pill's icon, hue and label. */
  format: string;
  /** Resting rotation, so the eight chips read as scattered rather than stacked. */
  rotation: string;
  /**
   * Offset into the shared 6 s float cycle. Negative, which starts the chip mid-cycle: the
   * eight would otherwise rise and fall in unison and read as one moving block.
   */
  delay: string;
}

/**
 * The eight formats named in the mockup, in its order.
 *
 * Every id is a `catalog-format-registry` entry, so the pill's colour, icon and label all
 * come from the same place the rest of the app reads them from — there is no second list of
 * format names to keep in step with the registry.
 */
const FORMAT_CHIPS: readonly FormatChip[] = [
  { format: 'openapi', rotation: '-3deg', delay: '0s' },
  { format: 'asyncapi', rotation: '2deg', delay: '-1.2s' },
  { format: 'graphql', rotation: '-2deg', delay: '-2.4s' },
  { format: 'grpc', rotation: '3deg', delay: '-0.6s' },
  { format: 'avro', rotation: '2deg', delay: '-3.1s' },
  { format: 'wsdl', rotation: '-2deg', delay: '-4.2s' },
  { format: 'typespec', rotation: '2deg', delay: '-1.8s' },
  { format: 'odata', rotation: '-3deg', delay: '-5s' },
];

/**
 * The brand panel's content.
 *
 * @returns The lock-up, the positioning copy and the floating format chips.
 */
export function LoginBrandPanel() {
  return (
    <>
      <div className="flex items-center gap-3">
        <BrandMark variant="lockup" size={44} className="auth-brand__lockup" priority />
        <BetaBadge />
      </div>

      <p className="auth-eyebrow mt-8">The API design environment</p>

      <h2 className="auth-display mt-3">
        Design. Version.
        <br />
        <span className="auth-display__accent">Publish your APIs.</span>
      </h2>

      <p className="auth-lede mt-4">
        Model your API once, then import, lint, diff, and export across every format your
        consumers speak — with honest fidelity at each step.
      </p>

      {/* Ornament: the same eight names are read aloud nowhere else on the page, and a
          screen-reader user gains nothing from a list of pills they cannot act on. */}
      <div className="auth-chips mt-8" aria-hidden="true">
        {FORMAT_CHIPS.map((chip) => (
          <FormatPill
            key={chip.format}
            format={chip.format}
            style={
              { '--chip-rot': chip.rotation, '--chip-delay': chip.delay } as CSSProperties
            }
          />
        ))}
      </div>
    </>
  );
}

export default LoginBrandPanel;
