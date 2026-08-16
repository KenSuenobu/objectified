/**
 * `destructiveConfirm()` — the DESIGN.md §8 copy rule (HIVE-2.7, #5286).
 *
 * §8 is four requirements in one line: red primary, object named, consequence sentence, and
 * type-to-confirm for the irreversible cases. Twenty call sites each met a different subset
 * of them, so the rule is now one function — and a rule expressed as a function is a rule
 * that can be *tested*, which is the only reason it stays true after the next screen lands.
 */

import { destructiveConfirm } from '../src/app/components/dialogs/destructiveConfirm';

describe('destructiveConfirm', () => {
  const role = {
    action: 'Delete',
    noun: 'role',
    name: 'Editor',
    consequence: 'Members holding this role lose its permissions immediately.',
  } as const;

  describe('the §8 requirements', () => {
    it('names the object in the title, in quotes, beside its kind', () => {
      expect(destructiveConfirm(role).title).toBe('Delete role "Editor"?');
    });

    it('drops the kind when the name already carries it', () => {
      expect(
        destructiveConfirm({
          action: 'Offboard',
          name: 'Ada Lovelace',
          consequence: 'They lose all access to this tenant.',
        }).title
      ).toBe('Offboard "Ada Lovelace"?');
    });

    it('carries the consequence sentence as the message', () => {
      expect(destructiveConfirm(role).message).toBe(role.consequence);
    });

    it('is always a red primary', () => {
      expect(destructiveConfirm(role).variant).toBe('danger');
    });

    it('labels the button with a verb phrase, never "OK"', () => {
      expect(destructiveConfirm(role).confirmLabel).toBe('Delete role');
    });

    it('labels the button with the bare verb when there is no kind', () => {
      expect(
        destructiveConfirm({ action: 'Revoke', name: 'ci-deploy', consequence: 'The key stops working.' })
          .confirmLabel
      ).toBe('Revoke');
    });

    it('lets a call site override the button label without losing the rest', () => {
      const options = destructiveConfirm({ ...role, confirmLabel: 'Delete for everyone' });
      expect(options.confirmLabel).toBe('Delete for everyone');
      expect(options.title).toBe('Delete role "Editor"?');
      expect(options.variant).toBe('danger');
    });

    it('offers a cancel, so the destructive button is never the only way out', () => {
      expect(destructiveConfirm(role).cancelLabel).toBe('Cancel');
    });
  });

  describe('the type-to-confirm gate', () => {
    it('is off unless asked for — a gate on every confirm is a gate nobody reads', () => {
      const options = destructiveConfirm(role);
      expect(options.typeToConfirm).toBeUndefined();
      expect(options.consequence).toBeUndefined();
    });

    it('gates on the object’s own name, so the click cannot land on the wrong row', () => {
      expect(destructiveConfirm({ ...role, typeToConfirm: true }).typeToConfirm).toBe('Editor');
    });

    it('says why the gate is there rather than leaving the field to explain itself', () => {
      expect(destructiveConfirm({ ...role, typeToConfirm: true }).consequence).toBe(
        'This is permanent and cannot be undone.'
      );
    });

    it('keeps the caller’s own consequence as the message when gated', () => {
      expect(destructiveConfirm({ ...role, typeToConfirm: true }).message).toBe(role.consequence);
    });
  });

  describe('the three cases #5286 names', () => {
    it.each([
      ['permanent project delete', 'Permanently delete', 'project', 'Payments API'],
      ['tenant delete', 'Delete', 'tenant', 'Acme Corp'],
      ['admin user delete', 'Delete', 'user', 'ada@example.com'],
    ])('gates the %s on the object name', (_case, action, noun, name) => {
      const options = destructiveConfirm({
        action,
        noun,
        name,
        consequence: 'Everything it owns is destroyed.',
        typeToConfirm: true,
      });
      expect(options.typeToConfirm).toBe(name);
      expect(options.title).toBe(`${action} ${noun} "${name}"?`);
      expect(options.variant).toBe('danger');
    });
  });

  it('is pure — the same spec twice gives equal options and shares nothing', () => {
    const first = destructiveConfirm(role);
    const second = destructiveConfirm(role);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});
