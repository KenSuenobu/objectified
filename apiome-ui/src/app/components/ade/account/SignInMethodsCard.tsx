'use client';

/**
 * Profile's Sign-in methods card (HIVE-4.7, #5301).
 *
 * Authority: `docs/mockups/account/profile.html` §"Sign-in methods", whose Adds list asks the
 * card to name "the concrete methods (password + linked providers) instead of prose only".
 *
 * The prose stays — it is what the Keeps list preserves, and it is the only place that says
 * what linking is *for* — and the reader's own methods are listed under it. Both facts come
 * from server actions the neighbouring Linked accounts page already calls, so this is a
 * second reader of existing data rather than a new source.
 *
 * ### Why the provider marks are drawn without their brand classes
 *
 * `getProviderBrand` pairs each mark with a colour class (`text-orange-600` for GitLab, a
 * literal `#007DC1` for Okta). Those are correct where a provider is being *chosen* — a
 * sign-in button, the link dialog — because a brand hue is an identity, not a state. In a
 * quiet list of methods the reader already has, the glyph is a bullet: it takes the tile's
 * own token ink, so the card follows all nine themes. The marks themselves are still the
 * providers'.
 */

import * as React from 'react';
import Link from 'next/link';
import { Link as LinkIcon, Lock } from 'lucide-react';

import { Badge } from '@/app/components/ui/Badge';
import { Button } from '@/app/components/ui/Button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/app/components/ui/Card';
import { Skeleton } from '@/app/components/ui/Skeleton';
import { ICON_SIZE } from '@/app/components/ui/iconSizes';
import { getProviderBrand } from '@/app/components/auth/provider-brand';
import { LINKED_ACCOUNTS_ROUTE } from './AccountTabs';
import type { SignInMethodRow } from './accountModel';

/** Props for {@link SignInMethodsCard}. */
export interface SignInMethodsCardProps {
  /** The reader's methods, password first. Ignored while `loading`. */
  methods: readonly SignInMethodRow[];
  /** Whether the two lookups behind the list are still in flight. */
  loading: boolean;
}

/**
 * One method row.
 *
 * @param props.method The row to draw.
 * @returns The row.
 */
function MethodRow({ method }: { method: SignInMethodRow }) {
  const Icon = method.isPassword ? Lock : getProviderBrand(method.id).Icon;

  return (
    <li className="acct-signin__row" data-testid={`profile-signin-${method.id}`}>
      <span className="acct-glyph acct-glyph--sm" aria-hidden>
        <Icon size={ICON_SIZE.dense} />
      </span>
      <span className="acct-signin__body">
        <span className="acct-signin__name">{method.label}</span>
        {method.detail ? <span className="acct-signin__sub">{method.detail}</span> : null}
      </span>
      <Badge status={method.status}>{method.badge}</Badge>
    </li>
  );
}

/**
 * Draw the card.
 *
 * @param props See {@link SignInMethodsCardProps}.
 * @returns The Sign-in methods card.
 */
export function SignInMethodsCard({ methods, loading }: SignInMethodsCardProps) {
  return (
    <Card data-testid="profile-signin-methods">
      <CardHeader className="acct-card__header">
        <CardTitle className="acct-card__title">
          <LinkIcon size={ICON_SIZE.dense} aria-hidden />
          Sign-in methods
        </CardTitle>
        <span className="acct-card__note">Linked identity providers</span>
      </CardHeader>
      <CardContent>
        <p className="acct-prose">
          Link providers like GitHub, GitLab, or Microsoft for single sign-on, and manage or
          unlink them at any time.
        </p>

        {loading ? (
          // A skeleton is decoration (`ui/Skeleton`), so the region around it carries the
          // announcement rather than the bars themselves.
          <div className="acct-signin" role="status" data-testid="profile-signin-loading">
            <span className="sr-only">Loading sign-in methods…</span>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : methods.length > 0 ? (
          <ul className="acct-signin">
            {methods.map((method) => (
              <MethodRow key={method.id} method={method} />
            ))}
          </ul>
        ) : (
          <p className="acct-empty-line" data-testid="profile-signin-empty">
            No sign-in methods resolved for this account.
          </p>
        )}
      </CardContent>
      <CardFooter className="acct-card__footer">
        <Button asChild variant="outline" size="sm" className="w-full">
          <Link href={LINKED_ACCOUNTS_ROUTE}>
            <LinkIcon aria-hidden />
            Manage linked accounts
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

export default SignInMethodsCard;
