'use client';

/**
 * Brand icons for provider-registry entries (OLO-2.3, #4195).
 *
 * The registry (`lib/auth/provider-registry.ts`) is React-free so server code can import it;
 * this module holds the client-side visual half — one brand icon (plus its color classes) per
 * provider id. Server components pass `ProviderSummary` objects (serializable) to client
 * components, which resolve the icon here by id.
 *
 * Adding a provider: add its registry entry, then one `PROVIDER_BRANDS` entry here.
 */
import { KeyRound } from 'lucide-react';
import { SiAmazon, SiAuth0, SiGithub, SiGitlab, SiGoogle, SiKeycloak, SiLine, SiOkta } from 'react-icons/si';

/** Props every brand icon accepts (matches the `react-icons` component contract we use). */
interface BrandIconProps {
  size?: number;
  className?: string;
}

/**
 * The Microsoft four-square logo.
 *
 * `react-icons`' Simple Icons set no longer ships Microsoft brand marks (trademark policy), so
 * the mark is inlined. The four fills are the official Microsoft brand colors — logo content,
 * not theme styling, so they stay literal rather than CSS classes.
 *
 * @param size Rendered width/height in px (defaults to 20, like the SSO button icons).
 * @param className Optional extra classes on the root svg.
 * @returns The Microsoft logo as an inline svg.
 */
export function MicrosoftIcon({ size = 20, className }: BrandIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 23 23"
      className={className}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1" y="1" width="10" height="10" fill="#f25022" />
      <rect x="12" y="1" width="10" height="10" fill="#7fba00" />
      <rect x="1" y="12" width="10" height="10" fill="#00a4ef" />
      <rect x="12" y="12" width="10" height="10" fill="#ffb900" />
    </svg>
  );
}

/** A provider's visual identity: its icon component and the color classes to render it with. */
export interface ProviderBrand {
  /** Icon component accepting `size` and `className`. */
  Icon: React.ComponentType<BrandIconProps>;
  /** Color classes for the icon (empty when the icon carries its own colors, e.g. Microsoft). */
  iconClassName: string;
}

/** Brand visuals per provider-registry id. */
const PROVIDER_BRANDS: Record<string, ProviderBrand> = {
  github: { Icon: SiGithub, iconClassName: 'text-slate-800 dark:text-slate-100' },
  gitlab: { Icon: SiGitlab, iconClassName: 'text-orange-600' },
  azure: { Icon: MicrosoftIcon, iconClassName: '' },
  google: { Icon: SiGoogle, iconClassName: 'text-blue-500' },
  okta: { Icon: SiOkta, iconClassName: 'text-[#007DC1]' },
  aws: { Icon: SiAmazon, iconClassName: 'text-orange-500' },
  keycloak: { Icon: SiKeycloak, iconClassName: 'text-[#008AAA]' },
  // Generic OIDC (OLO-9.6): key-style mark — no single vendor brand.
  oidc: { Icon: KeyRound, iconClassName: 'text-slate-600 dark:text-slate-300' },
  auth0: { Icon: SiAuth0, iconClassName: 'text-[#EB5424]' },
  line: { Icon: SiLine, iconClassName: 'text-[#06C755]' },
};
/** Neutral fallback for provider ids without a brand entry (e.g. a legacy linked account). */
const FALLBACK_BRAND: ProviderBrand = {
  Icon: KeyRound,
  iconClassName: 'text-slate-400 dark:text-slate-500',
};

/**
 * Resolve the brand visuals for a provider id.
 *
 * @param providerId Provider-registry id (e.g. `github`).
 * @returns The provider's brand, or a neutral key icon for unknown ids so surfaces listing
 *   historical linked accounts never crash on a provider this build no longer knows.
 */
export function getProviderBrand(providerId: string): ProviderBrand {
  return PROVIDER_BRANDS[providerId] ?? FALLBACK_BRAND;
}
