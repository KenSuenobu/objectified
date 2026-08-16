'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { ArrowUpRight, X } from 'lucide-react';
import { cn } from '../../../../lib/utils';

/**
 * Drawer — the Hive right side-sheet (HIVE-2.2, #5281).
 *
 * Authority: `docs/mockups/assets/hive.css` §15 (`.drawer`), `docs/mockups/DESIGN.md` §1.6
 * and §5.4 ("Drawer — right, 520/680/860 px, for detail/quick-edit").
 *
 * The redesign's progressive-disclosure device: a row opens *beside* the list instead of
 * navigating away from it, so the reader keeps their place, their scroll position and their
 * filters. That is the whole argument for it, and it is why a drawer is for detail and
 * quick-edit only — real work still gets a page, which is what `DrawerOpenFullPageLink`
 * offers when one exists.
 *
 * Built on Radix's Dialog for the behaviours the ticket asks for and which are genuinely
 * hard to get right by hand: the focus trap while open, `Esc` and scrim dismissal, focus
 * restored to whatever opened it, `aria-modal` and the inert background. Two drawers, or a
 * drawer over a dialog, stack correctly for free — each overlay portals to the end of
 * `<body>`, so the newest paints last and its trap is the innermost.
 *
 * One surface predates this primitive: the preferences pane
 * (`components/ade/PreferencesDrawer.tsx`, HIVE-1.4) builds its own side sheet on the same
 * Radix Dialog, because there was nothing to build on when it landed. It is deliberately
 * left alone here — it is a shipped, snapshot-tested surface and this ticket adds
 * primitives rather than re-plumbing pages — but it is the obvious first migration for
 * whoever next touches it.
 *
 * ```tsx
 * <Drawer open={open} onOpenChange={setOpen}>
 *   <DrawerContent size="lg">
 *     <DrawerHeader>
 *       <DrawerTitle>Audit event</DrawerTitle>
 *       <DrawerDescription>evt_9c1d · Aug 15, 09:12:44</DrawerDescription>
 *     </DrawerHeader>
 *     <DrawerBody>…</DrawerBody>
 *     <DrawerFooter>
 *       <DrawerOpenFullPageLink href="/ade/dashboard/audit/evt_9c1d" />
 *       <DrawerClose asChild><Button variant="outline">Close</Button></DrawerClose>
 *     </DrawerFooter>
 *   </DrawerContent>
 * </Drawer>
 * ```
 */

const Drawer = DialogPrimitive.Root;
const DrawerTrigger = DialogPrimitive.Trigger;
const DrawerPortal = DialogPrimitive.Portal;
const DrawerClose = DialogPrimitive.Close;

const DrawerOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-[9998] bg-overlay backdrop-blur-sm', className)}
    {...props}
  />
));
DrawerOverlay.displayName = 'DrawerOverlay';

/**
 * The three drawer widths of DESIGN.md §5.4, in `rem` so they follow the font-size
 * preference, and as `max-w-[…]` arbitrary values so `tailwind-merge` still lets a caller's
 * own `max-w-*` win.
 *
 * The sheet is full-height and full-width below its cap: on a phone the drawer *is* the
 * screen, which is the only honest thing a 520 px sheet can do at 380 px.
 */
const drawerContentVariants = cva(
  [
    'hive-drawer fixed inset-y-0 right-0 z-[9999] flex h-full w-full flex-col',
    'bg-surface text-fg shadow-lg focus:outline-none',
  ].join(' '),
  {
    variants: {
      size: {
        /** 520 px — one column of detail: an audit event, a member, a key. */
        default: 'max-w-[32.5rem]',
        /** 680 px — detail with a payload, a diff or a small table. */
        lg: 'max-w-[42.5rem]',
        /** 860 px — a preview beside its metadata. */
        xl: 'max-w-[53.75rem]',
      },
    },
    defaultVariants: { size: 'default' },
  }
);

export interface DrawerContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof drawerContentVariants> {
  /** Show the corner dismiss button (default `true`). */
  showCloseButton?: boolean;
  /** Accessible label for that button. */
  closeLabel?: string;
}

/**
 * The sheet itself.
 *
 * A `DrawerTitle` is required — Radix throws without one, and a sheet nobody can name is
 * not usable by a screen reader anyway. A `DrawerDescription` is optional, but a sheet that
 * has none must say so with `aria-describedby={undefined}`: Radix points the content at a
 * description id whether or not one was rendered, and a dangling reference is both a
 * console warning and a description assistive technology cannot resolve.
 */

const DrawerContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DrawerContentProps
>(
  (
    { className, children, size, showCloseButton = true, closeLabel = 'Close', ...props },
    ref
  ) => (
    <DrawerPortal>
      <DrawerOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(drawerContentVariants({ size }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            className="absolute right-4 top-4 cursor-pointer rounded-sm p-1 text-fg-subtle transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-none disabled:pointer-events-none"
            aria-label={closeLabel}
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DrawerPortal>
  )
);
DrawerContent.displayName = 'DrawerContent';

/** The header strip: title, sub-line, and room for the corner dismiss button. */
const DrawerHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex shrink-0 flex-col gap-0.5 border-b border-border px-5 py-4 pr-12 text-left',
      className
    )}
    {...props}
  />
);
DrawerHeader.displayName = 'DrawerHeader';

/**
 * The scrolling middle.
 *
 * The sheet is a column; only this part scrolls, so the header and footer stay put however
 * long the detail is.
 */
const DrawerBody = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', className)} {...props} />
);
DrawerBody.displayName = 'DrawerBody';

/** The action row, hairline-separated, actions to the right. */
const DrawerFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3',
      className
    )}
    {...props}
  />
);
DrawerFooter.displayName = 'DrawerFooter';

const DrawerTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-snug text-fg', className)}
    {...props}
  />
));
DrawerTitle.displayName = DialogPrimitive.Title.displayName;

const DrawerDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-xs text-fg-muted', className)}
    {...props}
  />
));
DrawerDescription.displayName = DialogPrimitive.Description.displayName;

export interface DrawerOpenFullPageLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  /** The route that shows the same object in full. */
  href: string;
}

/**
 * "Open full page ↗" — the escape hatch DESIGN.md §5.4 requires *when a page exists*.
 *
 * Deliberately a plain `<a>` and not `next/link`: the drawer's whole promise is that the
 * list behind it is undisturbed, so leaving it is a real navigation the reader chose, and
 * this component is also imported by surfaces (the design-system gallery, the Studio) that
 * are not always inside a Next router.
 *
 * It sits first in the footer, where the mockup puts it, and reads as a link rather than a
 * button because that is what it is.
 */
const DrawerOpenFullPageLink = React.forwardRef<HTMLAnchorElement, DrawerOpenFullPageLinkProps>(
  ({ className, children = 'Open full page', ...props }, ref) => (
    <a
      ref={ref}
      className={cn(
        'mr-auto inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent-fg',
        'transition-colors hover:text-accent focus-visible:outline-none',
        className
      )}
      {...props}
    >
      {children}
      <ArrowUpRight className="size-[var(--icon-button)] shrink-0" aria-hidden="true" />
    </a>
  )
);
DrawerOpenFullPageLink.displayName = 'DrawerOpenFullPageLink';

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerBody,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
  DrawerOpenFullPageLink,
  drawerContentVariants,
};
