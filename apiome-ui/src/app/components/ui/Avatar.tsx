'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../../../lib/utils';

/**
 * Avatar — the Hive identity mark (HIVE-2.2, #5281).
 *
 * Authority: `docs/mockups/assets/hive.css` §19 (`.avatar`, `.avatar-stack`),
 * `docs/mockups/DESIGN.md` §2 (the hexagon is a brand shape) and §7.
 *
 * Two shapes, one component. A **person** is a circle; a **workspace** is a hexagon, which
 * is the one place DESIGN.md §2 lets the honeycomb into the interface proper. Both fall
 * back to initials, because an avatar that has no image still has to identify someone.
 *
 * ### Colour is a function of identity, not of the call site
 *
 * `tone="auto"` (the default when an `id` is given) hashes the id into one of the five
 * §7 tints, so the same person is the same colour on the members table, in the audit
 * drawer and in the rail — without a colour being stored anywhere or a page choosing one.
 * The five tints are the *existing* role tokens (`accent` · `violet` · `ok` · `orange` ·
 * `rose`, each `-soft` with its `-fg` ink) rather than five new colours: they already carry
 * a per-theme swap and a legible ink, so an avatar reads correctly in all nine themes and
 * the token layer gains nothing to keep in step.
 */

/** Deterministic tints, in the order `hive.css` names them `--a` … `--e`. */
const TONE_CLASS = {
  a: 'bg-accent-soft text-accent-fg',
  b: 'bg-violet-soft text-violet-fg',
  c: 'bg-ok-soft text-ok-fg',
  d: 'bg-orange-soft text-orange-fg',
  e: 'bg-rose-soft text-rose-fg',
  /** No identity to hash — a placeholder, a "+4" overflow chip. */
  neutral: 'bg-inset text-fg-muted',
  /** Brand moments: the workspace mark, the launcher, onboarding. `--fg-on-accent`
   *  rather than `--ink-fg`, because the gradient is the two fixed brand hues in every
   *  theme and the ink on it has to be fixed too — a dark theme lightens `--ink`, and
   *  with it the ink meant to sit on ink. */
  brand: 'bg-[image:var(--gradient-brand)] text-fg-on-accent',
  /** Honey — reserved for the brand's own surfaces (DESIGN.md §2). */
  honey: 'bg-[image:var(--gradient-honey)] text-honey-ink',
} as const;

/** A tone a caller may name outright. */
export type AvatarTone = keyof typeof TONE_CLASS;

/** The five tints an id may hash to, in order. */
export const AVATAR_TINTS = ['a', 'b', 'c', 'd', 'e'] as const satisfies readonly AvatarTone[];

/**
 * The tint an identity always gets.
 *
 * A small FNV-1a-style rolling hash over the string, taken modulo the five tints. Stable
 * across processes and releases — it reads only the characters — which is the whole point:
 * the colour is a property of the id, not of when or where it was rendered.
 *
 * @param id Any stable identifier: a uuid, an email, a slug, a display name.
 * @returns The tint for that id, or `neutral` for an empty id.
 */
export function avatarToneFor(id: string | null | undefined): AvatarTone {
  if (!id) return 'neutral';
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    // × 16777619 in 32-bit arithmetic, written as shifts so it stays exact in a double.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return AVATAR_TINTS[hash % AVATAR_TINTS.length];
}

/**
 * The initials to draw when there is no image.
 *
 * First letters of the first two words, so "Ada Lovelace" is `AL` and "payments-api" is
 * `PA`; a single word gives its first two letters. Punctuation and digits are kept — an id
 * like `evt_9c1d` should still say something — and an unusable name falls back to `?`
 * rather than to an empty circle.
 *
 * @param name A display name, an email address or an id.
 * @returns One or two upper-case characters.
 */
export function avatarInitials(name: string | null | undefined): string {
  const source = (name ?? '').trim();
  if (!source) return '?';
  const local = source.includes('@') ? source.slice(0, source.indexOf('@')) : source;
  const words = local.split(/[\s._\-/]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const letters =
    words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0].slice(0, 2);
  return letters.toLocaleUpperCase();
}

/**
 * The five sizes of DESIGN.md §7, as `rem` so they follow the font-size preference.
 *
 * Type steps deviate from `hive.css` in one place, deliberately: the mockup sets the `xs`
 * and `sm` initials at 9 px and 10 px, below the §3.2 floor of 11 px. Both use `text-2xs`
 * here — the scale is the vocabulary (HIVE-1.6), and two characters still fit.
 */
const avatarVariants = cva(
  [
    'relative inline-grid shrink-0 select-none place-items-center overflow-hidden',
    'bg-inset font-semibold leading-none text-fg-muted',
  ].join(' '),
  {
    variants: {
      size: {
        /** 20 px — inside a table row, a chip, a stack. */
        xs: 'size-5 text-2xs',
        /** 26 px — a list row, the rail's workspace switcher. */
        sm: 'size-6.5 text-2xs',
        /** 32 px — the default: a card, a header, a menu. */
        default: 'size-8 text-xs',
        /** 44 px — a detail drawer header. */
        lg: 'size-11 text-base',
        /** 72 px — a profile page. */
        xl: 'size-18 text-2xl',
      },
      shape: {
        /** People. */
        circle: 'rounded-full',
        /** Workspaces — the honeycomb silhouette of DESIGN.md §2. */
        hex: 'avatar-hex',
      },
    },
    defaultVariants: { size: 'default', shape: 'circle' },
  }
);

export interface AvatarProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>,
    VariantProps<typeof avatarVariants> {
  /** The identity: a display name, an email address, a workspace name. */
  name?: string | null;
  /**
   * The stable identifier the tone is hashed from — usually the record's id. Falls back to
   * `name`, so an avatar that only ever has a name is still the same colour everywhere.
   *
   * Named `seed` rather than `id` because the element's own `id` attribute has to stay
   * available: an avatar is a legitimate `aria-labelledby` target.
   */
  seed?: string | null;
  /** Name the tone outright — `brand` for a workspace mark, `neutral` for a placeholder. */
  tone?: AvatarTone | 'auto';
  /** An image to draw instead of the initials. */
  src?: string | null;
  /** Initials to draw instead of the ones derived from `name`, e.g. a `+4` overflow chip. */
  children?: React.ReactNode;
}

const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(
  (
    { className, size, shape, name, seed, tone = 'auto', src, children, title, ...props },
    ref
  ) => {
    const resolvedTone = tone === 'auto' ? avatarToneFor(seed ?? name) : tone;
    const initials = children ?? avatarInitials(name);

    return (
      <span
        ref={ref}
        // The avatar is a picture of a name that is written beside it in every layout the
        // design has, so it is decorative by default: `title` (or an `aria-label` a caller
        // passes) is what promotes it to something a screen reader stops on.
        aria-hidden={title || props['aria-label'] || props['aria-labelledby'] ? undefined : true}
        title={title}
        data-tone={resolvedTone}
        className={cn(avatarVariants({ size, shape }), TONE_CLASS[resolvedTone], className)}
        {...props}
      >
        {src ? (
          /* `alt=""`: the picture says nothing the name beside it does not, and when the
             avatar *is* the identity its accessible name comes from the wrapper's `title`
             or `aria-label` — one name, in one place, whether or not the image loads.

             A plain `<img>`, because an avatar URL is arbitrary and remote (gravatar, an
             OAuth provider's CDN) and `next/image` would need every one of those hosts
             listed in `next.config.ts`. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="size-full object-cover" />
        ) : (
          initials
        )}
      </span>
    );
  }
);
Avatar.displayName = 'Avatar';

export interface AvatarStackProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The avatars, in reading order. */
  children?: React.ReactNode;
}

/**
 * AvatarStack — overlapped avatars for "who is on this" (hive.css `.avatar-stack`).
 *
 * Each avatar after the first slides 8 px under the one before it and carries a ring in the
 * surface colour, so the overlap reads as depth rather than as a smudge. The ring is drawn
 * with a shadow rather than a border, so it costs no layout and the hex silhouette keeps
 * its shape.
 */
const AvatarStack = React.forwardRef<HTMLDivElement, AvatarStackProps>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'inline-flex items-center',
        '[&>*]:shadow-[0_0_0_2px_var(--bg-surface)] [&>*:not(:first-child)]:-ml-2',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
);
AvatarStack.displayName = 'AvatarStack';

export { Avatar, AvatarStack, avatarVariants };
