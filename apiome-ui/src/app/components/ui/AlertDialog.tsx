'use client';

import * as React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { cn } from '../../../../lib/utils';
import { buttonVariants, type ButtonProps } from './Button';
import { dialogContentVariants } from './Dialog';

/**
 * AlertDialog — the Hive confirm (HIVE-2.1, #5280).
 *
 * The same surface as {@link ./Dialog}, sized `sm` by default: a confirm asks one question
 * and shows two buttons, so DESIGN.md §7 gives it the 440 px width. The full destructive
 * layout — named object, consequence sentence, type-to-confirm — is HIVE-2.7's ticket; what
 * lands here is the seam it needs, `AlertDialogAction`'s `variant`.
 */

const AlertDialog = AlertDialogPrimitive.Root;

const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

const AlertDialogPortal = AlertDialogPrimitive.Portal;

const AlertDialogOverlay = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-[10050] bg-overlay backdrop-blur-sm',
      'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
      className
    )}
    {...props}
  />
));
AlertDialogOverlay.displayName = AlertDialogPrimitive.Overlay.displayName;

export interface AlertDialogContentProps
  extends React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Content> {
  /** One of the five DESIGN.md §7 dialog widths. A confirm defaults to `sm` (440 px). */
  size?: 'sm' | 'default' | 'lg' | 'xl' | 'full';
}

const AlertDialogContent = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Content>,
  AlertDialogContentProps
>(({ className, size = 'sm', ...props }, ref) => (
  <AlertDialogPortal>
    <AlertDialogOverlay />
    <div className="pointer-events-none fixed inset-0 z-[10051] flex items-center justify-center p-4">
      <AlertDialogPrimitive.Content
        ref={ref}
        className={cn(
          // The shared dialog surface, minus its own fixed centring: this one is centred by
          // the flex wrapper above, which is what keeps a confirm on top of an open dialog.
          dialogContentVariants({ size }),
          'pointer-events-auto static left-auto top-auto translate-x-0 translate-y-0',
          'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
          className
        )}
        {...props}
      />
    </div>
  </AlertDialogPortal>
));
AlertDialogContent.displayName = AlertDialogPrimitive.Content.displayName;

const AlertDialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />
);
AlertDialogHeader.displayName = 'AlertDialogHeader';

const AlertDialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end',
      className
    )}
    {...props}
  />
);
AlertDialogFooter.displayName = 'AlertDialogFooter';

const AlertDialogTitle = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Title
    ref={ref}
    className={cn('text-xl font-semibold leading-snug tracking-[-0.01em] text-fg', className)}
    {...props}
  />
));
AlertDialogTitle.displayName = AlertDialogPrimitive.Title.displayName;

const AlertDialogDescription = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-fg-muted', className)}
    {...props}
  />
));
AlertDialogDescription.displayName = AlertDialogPrimitive.Description.displayName;

export interface AlertDialogActionProps
  extends React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Action> {
  /** Button role. Pass `danger` for a destructive confirm (DESIGN.md §8 "Destructive"). */
  variant?: ButtonProps['variant'];
}

const AlertDialogAction = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Action>,
  AlertDialogActionProps
>(({ className, variant, ...props }, ref) => (
  <AlertDialogPrimitive.Action
    ref={ref}
    className={cn(buttonVariants({ variant }), className)}
    {...props}
  />
));
AlertDialogAction.displayName = AlertDialogPrimitive.Action.displayName;

const AlertDialogCancel = React.forwardRef<
  React.ElementRef<typeof AlertDialogPrimitive.Cancel>,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Cancel>
>(({ className, ...props }, ref) => (
  <AlertDialogPrimitive.Cancel
    ref={ref}
    className={cn(buttonVariants({ variant: 'outline' }), className)}
    {...props}
  />
));
AlertDialogCancel.displayName = AlertDialogPrimitive.Cancel.displayName;

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
