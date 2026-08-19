'use client';

/**
 * Which service a repository was registered through (HIVE-7.3, #5320).
 *
 * Authority: `docs/mockups/sources/repositories.html` — `badge--outline` with the provider's
 * own glyph, on the card's meta row and in the table's Provider column.
 *
 * ### Why the glyph is tinted and the label is not optional
 *
 * The ticket's first acceptance criterion is that the four providers are *distinguishable*.
 * Four outline chips that differ only by a monochrome glyph are not: at 11 px the GitHub and
 * GitLab marks are the same grey blob. So each provider's glyph takes a role token — and the
 * label is always drawn, because DESIGN.md §6 forbids colour as the only signal and a chip
 * whose whole meaning is a 11 px icon fails that on shape alone.
 *
 * The tints are role tokens (`--orange`, `--accent`, `--violet`), not brand hex: a provider is
 * not a format, so it does not belong in the fixed identity block (HIVE-2.4) and it follows the
 * reader's theme like everything else on the row.
 */

import * as React from 'react';
import { Github, Gitlab, Globe } from 'lucide-react';
import { SiBitbucket } from 'react-icons/si';

import { Badge } from '@/app/components/ui/Badge';
import { cn } from '@lib/utils';
import { REPOSITORY_PROVIDER_LABEL, type RepositoryProvider } from './repositoriesModel';

/** The glyph each provider draws. */
const PROVIDER_ICON: Readonly<
  Record<
    RepositoryProvider,
    React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>
  >
> = {
  github: Github,
  gitlab: Gitlab,
  bitbucket: SiBitbucket,
  public_url: Globe,
};

export interface ProviderGlyphProps {
  /** The provider whose mark to draw. */
  provider: RepositoryProvider;
  /** Sizing class for the glyph. */
  className?: string;
}

/**
 * One provider's mark, without the chip around it.
 *
 * Split out for HIVE-7.4 (#5321), whose linked-account tiles draw the mark beside a heading
 * rather than inside a badge. The tint travels with it — `.repo-provider__glyph` is keyed off a
 * `data-provider` ancestor, so the caller's wrapper carries the attribute — which is what keeps
 * a GitLab account orange on the Add-repository screen and in the repositories table without
 * either surface naming a hue.
 *
 * Always `aria-hidden`: a provider is named in words wherever this is drawn (DESIGN.md §6).
 *
 * @param props See {@link ProviderGlyphProps}.
 * @returns The provider's lucide (or Simple Icons) mark.
 */
export function ProviderGlyph({ provider, className }: ProviderGlyphProps) {
  const Icon = PROVIDER_ICON[provider];
  return <Icon className={cn('repo-provider__glyph', className)} aria-hidden />;
}

export interface ProviderBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The provider this repository came from. */
  provider: RepositoryProvider;
}

/**
 * Render one provider chip. See {@link ProviderBadgeProps}.
 *
 * @returns An outline badge carrying the provider's tinted glyph and its name.
 */
export function ProviderBadge({ provider, className, ...props }: ProviderBadgeProps) {
  return (
    <Badge
      variant="outline"
      data-provider={provider}
      data-testid="repository-provider"
      className={cn('repo-provider', className)}
      {...props}
    >
      <ProviderGlyph provider={provider} />
      {REPOSITORY_PROVIDER_LABEL[provider]}
    </Badge>
  );
}

export default ProviderBadge;
