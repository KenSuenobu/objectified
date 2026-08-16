import type { ConfirmDialogProps } from './ConfirmDialog';

/**
 * The destructive-confirm copy rule, as one function (HIVE-2.7, #5286).
 *
 * `docs/mockups/DESIGN.md` §8 states it in one line — *red primary, object named,
 * consequence sentence, optional type-to-confirm for tenants and projects* — and §8's copy
 * rule adds that a **button is a verb**, never "OK". Spread across twenty call sites that
 * became twenty near-misses: `Are you sure you want to delete the template "x"?` with an
 * "OK" button, `Delete tenant "x"? This action cannot be undone.` with no statement of what
 * is actually lost, and a permanent project delete that asked the reader to *type "DELETE"
 * mentally*.
 *
 * The shape is the same every time, so it is written once here and the call sites supply
 * only the four things that genuinely differ: the verb, the kind of thing, its name, and
 * what the click costs. Because it is a plain function over plain data it is unit-tested
 * directly, which is how the rule stays a rule.
 */

/** Everything a destructive confirm needs that is specific to the thing being destroyed. */
export interface DestructiveConfirmSpec {
  /** The verb, capitalised: `Delete`, `Remove`, `Offboard`, `Revoke`. */
  action: string;
  /**
   * What kind of thing it is, lower case: `role`, `tenant`, `collection`.
   *
   * Omit for an object whose name already says its kind (a person, say), and the title
   * becomes `Offboard "Ada Lovelace"?`.
   */
  noun?: string;
  /** The object's own name — the half of §8 that says the object must be **named**. */
  name: string;
  /**
   * One sentence, present tense, saying what is lost. Not "this cannot be undone" — that is
   * a property of the action, and {@link destructiveConfirm} adds it on its own when the
   * confirm is gated.
   */
  consequence: string;
  /**
   * Require the operator to type the object's name first.
   *
   * §8 names tenants and projects; #5286 adds the admin user delete. Reserved for those:
   * a gate on every confirm is a gate nobody reads.
   */
  typeToConfirm?: boolean;
  /** Override the button label when `${action} ${noun}` is not the verb phrase you want. */
  confirmLabel?: string;
}

/** The options a destructive confirm passes to `useDialog().confirm`. */
export type DestructiveConfirmOptions = Pick<
  ConfirmDialogProps,
  'title' | 'message' | 'consequence' | 'variant' | 'confirmLabel' | 'cancelLabel' | 'typeToConfirm'
>;

/**
 * Compose the DESIGN.md §8 destructive confirm for one object.
 *
 * @param spec The verb, the kind of thing, its name, and what the click costs.
 * @returns Options for `useDialog().confirm` — red primary, object named in the title, the
 *   consequence as its own sentence, and the type-to-confirm gate when asked for.
 *
 * @example
 * await confirm(destructiveConfirm({
 *   action: 'Delete',
 *   noun: 'role',
 *   name: role.name,
 *   consequence: 'Members holding this role lose its permissions immediately.',
 * }));
 * // → title:   Delete role "Editor"?
 * // → message: Members holding this role lose its permissions immediately.
 * // → button:  Delete role
 */
export function destructiveConfirm(spec: DestructiveConfirmSpec): DestructiveConfirmOptions {
  const { action, noun, name, consequence, typeToConfirm, confirmLabel } = spec;
  const subject = noun ? `${noun} "${name}"` : `"${name}"`;

  return {
    title: `${action} ${subject}?`,
    message: consequence,
    // A gate is only worth typing through if the reader knows why it is there, so the
    // irreversible cases say so out loud rather than relying on the field's presence.
    consequence: typeToConfirm ? 'This is permanent and cannot be undone.' : undefined,
    variant: 'danger',
    confirmLabel: confirmLabel ?? (noun ? `${action} ${noun}` : action),
    cancelLabel: 'Cancel',
    typeToConfirm: typeToConfirm ? name : undefined,
  };
}
