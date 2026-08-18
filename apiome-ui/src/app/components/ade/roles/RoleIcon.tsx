import * as React from 'react';
import { Crown, Eye, PencilRuler, Rocket, Shield } from 'lucide-react';

import type { RoleRecord } from '../access/accessApi';

/**
 * The glyph that stands for one role — HIVE-5.3 (#5306).
 *
 * Authority: `docs/mockups/workspace/roles.html`, which gives each built-in role a glyph of
 * its own in the list and repeats it at the head of the editor. One module rather than one
 * map per surface, so the crown beside "Owner" in the list is the crown above it in the
 * editor by construction.
 *
 * The elements are built once at module scope and handed out, rather than components being
 * looked up and rendered: a component *chosen* during render is a component React treats as
 * new on every pass, which resets anything it holds and is what `react-hooks/static-components`
 * exists to prevent.
 */

/** The four seeded roles, by slug. Anything else is a role this workspace wrote. */
const BUILTIN_GLYPH: Readonly<Record<string, React.ReactElement>> = {
  owner: <Crown aria-hidden />,
  admin: <Shield aria-hidden />,
  editor: <PencilRuler aria-hidden />,
  viewer: <Eye aria-hidden />,
};

/** Every custom role's glyph — the mockup's rocket. */
const CUSTOM_GLYPH = <Rocket aria-hidden />;

/** Props for {@link RoleIcon}. */
export interface RoleIconProps {
  /** The role to draw a glyph for. */
  role: RoleRecord;
}

/**
 * One role's glyph.
 *
 * @param props See {@link RoleIconProps}.
 * @returns The Lucide element; decorative, so it carries `aria-hidden`.
 */
export function RoleIcon({ role }: RoleIconProps) {
  return (role.is_builtin && BUILTIN_GLYPH[role.slug]) || CUSTOM_GLYPH;
}
