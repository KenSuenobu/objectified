/**
 * @jest-environment node
 *
 * ESLint's flat-config layer calls `structuredClone`, which `jest-environment-jsdom` does
 * not expose. Nothing here touches the DOM — the rule reads an AST.
 */

/**
 * `hive/no-native-dialog` — the native-dialog backstop (HIVE-2.7, #5286).
 *
 * The acceptance criterion is a `grep` that finds nothing, which is a claim about the tree
 * at one moment; `tests/hive-native-dialog-audit.test.ts` re-checks the tree, and this
 * proves the rule that catches the *next* one actually fires.
 *
 * The case that matters most is the negative one. `const { confirm } = useDialog()` is the
 * replacement this ticket ships, and a rule that flagged the very call it is asking for
 * would be turned off within a day — so the bindings are tested at least as hard as the
 * globals.
 */

import { RuleTester } from 'eslint';
import hive from '../eslint-rules/hive.js';

const rule = hive.rules['no-native-dialog'];

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
    // Declared the way a browser project declares them: no definition, so the rule's scope
    // walk sees exactly what it sees under `eslint-config-next`.
    globals: { window: 'readonly', globalThis: 'readonly', confirm: 'readonly', prompt: 'readonly', alert: 'readonly' },
  },
});

describe('hive/no-native-dialog', () => {
  it('is registered alongside the typography rule under the same plugin', () => {
    expect(hive.meta.name).toBe('hive');
    expect(Object.keys(hive.rules).sort()).toEqual(['no-native-dialog', 'no-px-typography']);
  });

  // `RuleTester` declares a `describe`/`it` of its own per case, so it runs in the suite
  // body rather than inside a test — Jest refuses a nested `it`.
  ruleTester.run('no-native-dialog', rule, {
    valid: [
      // The replacement itself: destructured from the hook, so the name is bound.
      { code: 'function C() { const { confirm } = useDialog(); return confirm({ message: "x" }); }' },
      { code: 'function C() { const { prompt } = useDialog(); return prompt({ label: "Name" }); }' },
      { code: 'function C() { const { alert } = useDialog(); return alert({ message: "x" }); }' },
      // All three at once, which is how a page that does every kind of thing spells it.
      {
        code: 'function C() { const { confirm, alert, prompt } = useDialog(); confirm({}); alert({}); prompt({}); }',
      },
      // Renamed on the way in — the common spelling where a local `confirm` already exists.
      { code: 'function C() { const { confirm: confirmDialog } = useDialog(); return confirmDialog({}); }' },
      // Bound by an import rather than a hook.
      { code: 'import { confirm } from "./dialogs"; confirm({});' },
      // A parameter, and a plain local function of the same name.
      { code: 'function run(confirm) { return confirm({}); }' },
      { code: 'function alert(message) { return message; } alert("x");' },
      // A method on something that is not a global object.
      { code: 'page.confirm();' },
      { code: 'this.alert("x");' },
      { code: 'dialogs.prompt("x");' },
      // Not a call at all — a property, a key, a JSX prop.
      { code: 'const o = { confirm: true, prompt: "hi", alert: null };' },
      { code: 'const a = <Button onConfirm={confirm} />;' },
      // A computed member expression names nothing statically.
      { code: 'window[name]();' },
    ],
    invalid: [
      // Through a global object.
      {
        code: 'window.confirm("Delete this?");',
        errors: [{ messageId: 'nativeDialog', data: { name: 'confirm', member: 'confirm' } }],
      },
      {
        code: 'window.prompt("Name for the new role");',
        errors: [{ messageId: 'nativeDialog' }],
      },
      { code: 'window.alert("Saved");', errors: [{ messageId: 'nativeDialog' }] },
      { code: 'globalThis.confirm("x");', errors: [{ messageId: 'nativeDialog' }] },
      { code: 'self.alert("x");', errors: [{ messageId: 'nativeDialog' }] },
      // Bare, with nothing in scope binding the name — the admin console's spelling.
      {
        code: 'function h() { if (!confirm(`Delete tenant "${t.name}"?`)) { return; } }',
        errors: [{ messageId: 'nativeDialog' }],
      },
      { code: 'const name = prompt("Rename collection");', errors: [{ messageId: 'nativeDialog' }] },
      { code: 'alert("Something went wrong");', errors: [{ messageId: 'nativeDialog' }] },
      // Inside a component that binds a *different* member — the near miss the scope walk
      // has to get right: `alert` here is still the browser's.
      {
        code: 'function C() { const { confirm } = useDialog(); confirm({}); alert("x"); }',
        errors: [{ messageId: 'nativeDialog', data: { name: 'alert', member: 'alert' } }],
      },
      // A binding in a sibling scope does not reach this call.
      {
        code: 'function A() { const confirm = () => true; } function B() { confirm("x"); }',
        errors: [{ messageId: 'nativeDialog' }],
      },
      // Two on one line are two reports, not one.
      {
        code: 'window.confirm("a"); window.prompt("b");',
        errors: [{ messageId: 'nativeDialog' }, { messageId: 'nativeDialog' }],
      },
    ],
  });

  it('names the replacement in the message, so the fix is in the error', () => {
    const { messages } = rule.meta;
    expect(messages.nativeDialog).toContain('useDialog()');
    expect(messages.nativeDialog).toContain('DialogProvider');
    expect(messages.nativeDialog).toContain('#5286');
  });
});
