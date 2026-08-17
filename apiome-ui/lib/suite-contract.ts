/**
 * Generic commercial suite navigation contract.
 *
 * Open-source `apiome-ui` owns the shell types, entitlement annotation, and
 * menu renderer. Product-specific destinations (labels, badges, routes) are
 * contributed at runtime by a commercial suite host — this module never names
 * a particular commercial product.
 */

/** Labeled heading that groups destinations inside a nav dropdown. */
export type SuiteNavMenuGroup = {
  id: string;
  label: string;
};

/** One destination inside a suite nav dropdown. */
export type SuiteNavMenuItem = {
  id: string;
  label: string;
  description?: string;
  href: string;
  icon?: string;
  external?: boolean;
  opensNewBrowser?: boolean;
  featureFlag?: string;
  anyFeatureFlags?: string[];
  /** Id of the {@link SuiteNavMenuGroup} this destination belongs to. */
  group?: string;
  /** Short status chip beside the label, e.g. `Preview`. */
  badge?: string;
  /** `false` when the destination has not shipped yet. */
  enabled?: boolean;
  /** Explains how to obtain access when the viewer is not entitled. */
  accessNote?: string;
};

/** Top-level suite nav entry (trigger + optional grouped destinations). */
export type SuiteNavItem = {
  label: string;
  href: string;
  /** When provided, the shell uses this instead of href-prefix matching. */
  isActive?: (pathname: string) => boolean;
  featureFlag?: string;
  anyFeatureFlags?: string[];
  menuGroups?: SuiteNavMenuGroup[];
  menuItems?: SuiteNavMenuItem[];
};

/** Home-grid card contributed by a commercial suite package. */
export type SuiteHomeCard = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  href: string;
  enabled: boolean;
  external?: boolean;
  opensNewBrowser?: boolean;
  icon: string;
  /** @deprecated Pre-Hive gradient pair; the launcher draws `tone` since HIVE-4.5 (#5299). */
  accent: string;
  /** @deprecated Pre-Hive hover-shadow class. See {@link SuiteHomeCard.accent}. */
  glow: string;
  /**
   * Identity hue for the launcher card, named from the shared status vocabulary
   * (`accent`, `honey`, `violet`, `ok`, `orange`, `rose`, `neutral`, …). Optional and
   * validated by the host: an unknown value falls back to the commercial tone.
   */
  tone?: string;
  featureFlag?: string;
  anyFeatureFlags?: string[];
};

/**
 * Runtime contribution from a commercial suite host.
 *
 * Groups and items are merged into the built-in Designer suite entry.
 * `isActive` is OR'd with the shell's built-in studio-route active check.
 */
export type SuiteMenuContribution = {
  menuGroups?: SuiteNavMenuGroup[];
  menuItems?: SuiteNavMenuItem[];
  homeCards?: SuiteHomeCard[];
  isActive?: (pathname: string) => boolean;
  /** Extra license flag slugs for entitlement lookups. */
  featureFlagNames?: string[];
};

let contribution: SuiteMenuContribution | null = null;

/**
 * Register (or replace) the commercial suite menu contribution.
 *
 * @param next - Groups, destinations, optional active-path helper, and cards.
 */
export function contributeSuiteMenu(next: SuiteMenuContribution): void {
  contribution = next;
}

/** Current contribution, or `null` when no commercial host has registered. */
export function getSuiteMenuContribution(): SuiteMenuContribution | null {
  return contribution;
}

/** Clears the contribution — for tests only. */
export function resetSuiteMenuContribution(): void {
  contribution = null;
}

/**
 * Optional suite-trigger active helper from the contribution.
 *
 * @returns The contributed predicate, or `null` when none is registered.
 */
export function getSuiteTriggerIsActive(): ((pathname: string) => boolean) | null {
  return contribution?.isActive ?? null;
}

/**
 * Attempt to load a commercial suite host register entry.
 *
 * Resolves when `@suite/host/register` is linked into the install (commercial
 * builds). Open-source installs without the package are a no-op.
 */
export function tryLoadOptionalSuiteHost(): void {
  if (contribution) return;
  // `require` is a server-only Node primitive; there is nothing to load in the
  // browser bundle, so skip it there entirely.
  if (typeof window !== 'undefined') return;
  try {
    // Optional peer: present only when the commercial suite package is linked.
    // Resolve `require` indirectly through `eval` so bundlers (Turbopack in dev,
    // webpack in `next build`) don't statically resolve — and warn about — this
    // specifier, which is intentionally absent from open-source installs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-eval
    (eval('require') as NodeRequire)('@suite/host/register');
  } catch {
    // OSS / main-app without the commercial package — Design-only builtins.
  }
}
