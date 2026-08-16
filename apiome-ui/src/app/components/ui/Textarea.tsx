'use client';

import * as React from 'react';
import { cn } from '../../../../lib/utils';
import { CONTROL_FIELD_CLASS } from './Input';

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

/**
 * Textarea — the Hive multi-line field (HIVE-2.1, #5280).
 *
 * The same chrome as {@link Input} (hive.css §9 `.textarea`), with its own vertical padding
 * and a `min-height` of six `--space-4` units rather than a fixed control height, so it
 * still grows with the font-size preference.
 */
const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          CONTROL_FIELD_CLASS,
          'min-h-24 resize-y py-2.5 leading-normal',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';

export { Textarea };
