'use client';

import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react';
import type { ButtonProps } from '../ui/Button';

/**
 * The severity vocabulary the imperative dialogs share (HIVE-2.7, #5286).
 *
 * `ConfirmDialog` and `AlertDialog` had a `switch` each over the same four severities, and
 * the two disagreed: one spelled the red case `danger`, the other `error`, and both named
 * raw palette colours (`text-red-600`, `bg-indigo-600`) that no theme could reach. One
 * module now owns the mapping, so a confirm and the alert that reports its failure are the
 * same red — and both are tokens, which is what makes them follow the nine themes.
 *
 * The names are the DESIGN.md §7 tone roles; the pre-Hive spellings are kept as aliases so
 * no existing `variant=` needs an edit.
 */

/** The four severities a one-question dialog can carry. */
export type DialogTone = 'danger' | 'warning' | 'info' | 'success';

/** Every accepted spelling, including the pre-Hive aliases. */
export type DialogToneInput = DialogTone | 'error' | 'warn' | 'ok';

/** Pre-Hive spellings, mapped onto the tone they always meant. */
const TONE_ALIASES: Record<string, DialogTone> = {
  error: 'danger',
  warn: 'warning',
  ok: 'success',
};

/**
 * Resolve any accepted spelling to one of the four tones.
 *
 * @param variant The caller's `variant`, in any accepted spelling. Optional.
 * @param fallback The tone to use when `variant` is absent or unrecognised.
 * @returns The canonical tone.
 */
export function normalizeDialogTone(
  variant: DialogToneInput | undefined,
  fallback: DialogTone
): DialogTone {
  if (!variant) return fallback;
  if (variant in TONE_ALIASES) return TONE_ALIASES[variant];
  return variant as DialogTone;
}

/** The glyph each tone leads with — the same four `Alert` (HIVE-2.1) uses. */
export const DIALOG_TONE_ICON: Record<DialogTone, LucideIcon> = {
  danger: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle2,
};

/**
 * The ink each tone's glyph is drawn in — a token, so a theme swap reaches it.
 *
 * `text-danger` rather than `text-danger-fg`: the glyph is a mark on the dialog surface,
 * not text inside a tinted strip, so it wants the tone's full-strength colour.
 */
export const DIALOG_TONE_INK: Record<DialogTone, string> = {
  danger: 'text-danger',
  warning: 'text-warn',
  info: 'text-accent',
  success: 'text-ok',
};

/**
 * The button role each tone's primary action takes.
 *
 * DESIGN.md §8 puts a **red primary** on a destructive confirm; everything else keeps the
 * one-primary-per-screen rule and stays in ink.
 */
export const DIALOG_TONE_BUTTON: Record<DialogTone, NonNullable<ButtonProps['variant']>> = {
  danger: 'danger',
  warning: 'primary',
  info: 'primary',
  success: 'primary',
};

/** The title an alert falls back to when the caller gives none. */
export const DIALOG_TONE_TITLE: Record<DialogTone, string> = {
  danger: 'Error',
  warning: 'Warning',
  info: 'Information',
  success: 'Success',
};
