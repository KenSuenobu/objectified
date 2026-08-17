import { getStudioAppUrl } from './app-urls';
import type { ExternalLinkEntry, ExternalNavMenuGroup } from './external-links';
import { STUDIO_APP_ROUTES } from './studio-routes';
import { getSuiteMenuContribution, tryLoadOptionalSuiteHost } from './suite-contract';

/**
 * Built-in feature-flag slugs for the first-party applications this
 * open-source app actually ships: the Design group (Designer and Paths).
 *
 * Commercial products (Authoring — Scribe, Slate, hosted) are *not* named here.
 * They contribute their entitlement slugs at runtime through the suite
 * contract's {@link SuiteMenuContribution.featureFlagNames}; use
 * {@link getCommercialProductFlagNames} for the resolved set. This keeps
 * apiome-ui authoring-agnostic (#2466).
 */
export const COMMERCIAL_PRODUCT_FLAG_NAMES = ['designer', 'paths'] as const;

/** Ordered group headings for the built-in Designer suite dropdown (Design only). */
export const SUITE_MENU_GROUPS: ExternalNavMenuGroup[] = [{ id: 'design', label: 'Design' }];

export type CommercialProductFlagName = (typeof COMMERCIAL_PRODUCT_FLAG_NAMES)[number];

/**
 * All commercial product feature-flag slugs, built-ins plus any a commercial
 * suite host contributes at runtime.
 *
 * The Design builtins are always present; when the optional commercial host is
 * linked it adds its own slugs (e.g. Authoring's `scribe`/`slate`/`hosted`)
 * via the suite contract. Open-source installs without the host resolve to the
 * built-ins alone. Used for license entitlement lookups and the admin console's
 * product/flag split, so those keep working without naming any commercial
 * product in this repo.
 *
 * @returns The de-duplicated, order-preserving flag-slug list.
 */
export function getCommercialProductFlagNames(): string[] {
  tryLoadOptionalSuiteHost();
  const contributed = getSuiteMenuContribution()?.featureFlagNames ?? [];
  const names: string[] = [...COMMERCIAL_PRODUCT_FLAG_NAMES];
  for (const name of contributed) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function isStudioSurface(): boolean {
  return process.env.NEXT_PUBLIC_APP_SURFACE === 'studio';
}

function resolveStudioSurfaceHref(path: string): string {
  if (isStudioSurface()) return path;
  return new URL(path.replace(/^\//, ''), getStudioAppUrl()).toString();
}

function resolveStudioRootHref(): string {
  if (isStudioSurface()) return STUDIO_APP_ROUTES.root;
  return getStudioAppUrl();
}

function resolveStudioEditorHref(): string {
  return resolveStudioSurfaceHref(STUDIO_APP_ROUTES.editor);
}

function isAbsoluteHref(href: string): boolean {
  return href.startsWith('http://') || href.startsWith('https://');
}

/**
 * Built-in commercial applications shipped with apiome-ui.
 * Designer Suite visibility is gated by license feature flags (`designer` or `paths`).
 * Developer Suite is always listed on the home grid as coming soon.
 *
 * Additional suite destinations are contributed at runtime via
 * {@link contributeSuiteMenu} from a commercial host package.
 */
export function getBuiltinCommercialProducts(): ExternalLinkEntry[] {
  tryLoadOptionalSuiteHost();

  const suiteHref = resolveStudioRootHref();
  const editorHref = resolveStudioEditorHref();
  const pathsHref = resolveStudioSurfaceHref(STUDIO_APP_ROUTES.paths);

  return [
    {
      id: 'suite',
      navLabel: 'Designer',
      name: 'Designer Suite',
      tagline: 'Design workspace',
      description:
        'Schema design and API path modeling in one suite — canvas, versions, tags, and OpenAPI operations.',
      href: suiteHref,
      editorHref,
      icon: 'Layers',
      accent: 'from-violet-500 to-fuchsia-600',
      glow: 'group-hover:shadow-fuchsia-500/20',
      // The launcher's identity hue (HIVE-4.5): violet is the design language's
      // "another product" tone, so a licensed suite never reads as a core surface.
      tone: 'violet',
      anyFeatureFlags: ['designer', 'paths'],
      external: isAbsoluteHref(suiteHref),
      enabled: true,
      showInNav: true,
      showOnHome: true,
      menuGroups: SUITE_MENU_GROUPS,
      menuItems: [
        {
          id: 'suite-home',
          label: 'Suite Home',
          description: 'Projects, activity and resume cards',
          href: suiteHref,
          icon: 'LayoutDashboard',
          group: 'design',
          external: isAbsoluteHref(suiteHref),
        },
        {
          id: 'suite-designer',
          label: 'Designer',
          description: 'Model schemas and reusable types',
          href: editorHref,
          icon: 'Palette',
          group: 'design',
          featureFlag: 'designer',
          accessNote: 'Included with the Designer plan. Ask a tenant admin to enable it.',
          external: isAbsoluteHref(editorHref),
        },
        {
          id: 'suite-paths',
          label: 'Paths Editor',
          description: 'Design operations and contracts',
          href: pathsHref,
          icon: 'Route',
          group: 'design',
          featureFlag: 'paths',
          accessNote: 'Included with the Paths plan. Ask a tenant admin to enable it.',
          external: isAbsoluteHref(pathsHref),
        },
      ],
    },
    {
      id: 'developer-suite',
      navLabel: 'Developer',
      name: 'Developer Suite',
      tagline: 'Developer tools',
      description:
        'SDKs, tooling, and developer workflows for your API specifications — coming soon.',
      href: '#',
      icon: 'Workflow',
      accent: 'from-sky-500 to-indigo-600',
      glow: 'group-hover:shadow-sky-500/20',
      tone: 'violet',
      enabled: false,
      external: false,
      showInNav: true,
      showOnHome: true,
      // Rendered as a disabled dropdown in nav until developer products ship.
      menuItems: [],
    },
  ];
}

/**
 * Whether a flag slug names a commercial product (built-in or contributed).
 *
 * Resolved at runtime so contributed commercial slugs count too; not a type
 * guard because those slugs are not part of the static builtin union.
 *
 * @param flagName - Feature-flag slug to classify.
 * @returns True when the slug maps to a commercial product.
 */
export function isCommercialProductFlag(flagName: string): boolean {
  return getCommercialProductFlagNames().includes(flagName);
}
