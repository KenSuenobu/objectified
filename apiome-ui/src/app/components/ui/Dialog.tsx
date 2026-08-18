'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '../../../../lib/utils';

/**
 * Dialog — the Hive modal (HIVE-2.1, #5280).
 *
 * Authority: `docs/mockups/assets/hive.css` §17 (`.dialog`), `docs/mockups/DESIGN.md` §7,
 * gallery §Overlays.
 *
 * A 20 px-radius surface on a tinted scrim, at one of five widths. The widths are a
 * vocabulary rather than a free measurement: a confirm is `sm`, an ordinary form is the
 * default, a wizard is `lg`/`xl`, and `full` is the workbench case.
 */

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn('fixed inset-0 z-[9998] bg-overlay backdrop-blur-sm', className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * The five dialog widths of DESIGN.md §7, in `rem` so they follow the font-size preference.
 *
 * Stated as `max-w-[…]` arbitrary values, which `tailwind-merge` recognises — a caller's
 * own `max-w-2xl` therefore still wins, which is what keeps this a restyle rather than a
 * migration.
 */
const dialogContentVariants = cva(
  [
    'fixed left-1/2 top-1/2 z-[9999] grid w-full -translate-x-1/2 -translate-y-1/2',
    'max-h-[calc(100vh-3rem)] gap-4 overflow-y-auto rounded-xl bg-surface p-6 text-fg shadow-lg',
  ].join(' '),
  {
    variants: {
      size: {
        /** 440 px — a confirm, a rename, a single field. */
        sm: 'max-w-[27.5rem]',
        /** 560 px — an ordinary form. */
        default: 'max-w-[35rem]',
        /** 760 px — a wizard step, a two-column form. */
        lg: 'max-w-[47.5rem]',
        /** 960 px — a preview beside a form. */
        xl: 'max-w-[60rem]',
        /** 1200 px, near-full height — a workbench. */
        full: 'h-[calc(100vh-3rem)] max-w-[75rem]',
      },
    },
    defaultVariants: { size: 'default' },
  }
);

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
    VariantProps<typeof dialogContentVariants> {
  /** Show the corner dismiss button (default `true`). */
  showCloseButton?: boolean;
  /**
   * What the corner dismiss button is called.
   *
   * Default `Close`. A dialog where closing *costs* something says so here — the import
   * wizard's "Close (rolls back a running job)" — which is the only warning a reader gets
   * before pressing it. Matches `DrawerContent`'s prop of the same name.
   */
  closeLabel?: string;
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ className, children, size, showCloseButton = true, closeLabel = 'Close', ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(dialogContentVariants({ size }), className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close
          title={closeLabel}
          className="absolute right-4 top-4 rounded-sm p-1 text-fg-subtle transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-none disabled:pointer-events-none"
        >
          <X className="size-4" aria-hidden="true" />
          <span className="sr-only">{closeLabel}</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1 pr-8 text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

export interface DialogFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  /**
   * Let the footer run to the dialog's edges, tinted and separated by a hairline
   * (hive.css `.dialog__footer`). Default `true`.
   *
   * It bleeds with negative margins that match `DialogContent`'s own `p-6`, so an existing
   * dialog gets the footer with no edit. Pass `false` for a footer inside a dialog that has
   * had its padding changed.
   */
  bleed?: boolean;
}

const DialogFooter = ({ className, bleed = true, ...props }: DialogFooterProps) => (
  <div
    className={cn(
      'flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end',
      bleed &&
        '-mx-6 -mb-6 mt-2 rounded-b-xl border-t border-border bg-[color-mix(in_srgb,var(--bg-subtle)_60%,var(--bg-surface))] px-6 py-3.5',
      className
    )}
    {...props}
  />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-xl font-semibold leading-snug tracking-[-0.01em] text-fg', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-fg-muted', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  dialogContentVariants,
};
