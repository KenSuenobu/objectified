/**
 * @jest-environment node
 *
 * ESLint's flat-config layer calls `structuredClone`, which `jest-environment-jsdom` does
 * not expose. Nothing here touches the DOM — the rule reads an AST — so the suite runs on
 * the Node environment instead of polyfilling one global into the shared setup file.
 */

/**
 * `hive/no-px-typography` — the `rem` audit's lint backstop (HIVE-1.6, #5279).
 *
 * The acceptance criterion is that CI fails on a *newly introduced* hard-coded `px` font
 * size, which is a claim about a rule, not about the tree. `tests/hive-rem-audit.test.ts`
 * proves the tree is clean; this proves the rule that keeps it clean actually fires — and,
 * just as importantly, that it stays quiet for the three documented exemptions, since a
 * backstop everyone disables is worse than none.
 *
 * ESLint's own `RuleTester` drives it: given a source string it runs the rule exactly as
 * `yarn lint` would, so a rule that silently matches nothing cannot pass by accident.
 */

import { RuleTester } from 'eslint';
import hive from '../eslint-rules/hive.js';

const rule = hive.rules['no-px-typography'];

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

describe('hive/no-px-typography', () => {
  it('is registered under the plugin name the config uses', () => {
    expect(hive.meta.name).toBe('hive');
    expect(Object.keys(hive.rules)).toContain('no-px-typography');
  });

  // `RuleTester` declares a `describe`/`it` of its own per case, so it runs in the suite
  // body rather than inside a test — Jest refuses a nested `it`.
  ruleTester.run('no-px-typography', rule, {
    valid: [
      // The DESIGN.md §3.2 scale, which is what `text-*` now renders.
      { code: 'const a = <span className="text-2xs font-semibold" />;' },
      { code: 'const a = <span className="text-sm md:text-base" />;' },
      // Tokens, in an inline style or through a Tailwind arbitrary value.
      { code: "const a = <span style={{ fontSize: 'var(--fs-sm)' }} />;" },
      { code: 'const a = <span className="text-[var(--fs-2xs)]" />;' },
      // The three exemptions, each spending its module's constant rather than a literal.
      { code: 'const o = { fontSize: CODE_EDITOR_FONT_SIZE };' },
      { code: 'const a = <text fontSize={SVG_TEXT_SIZE.label} />;' },
      { code: 'const o = { fontSize: CANVAS_TYPE_SCALE.caps };' },
      // A computed size is already not a literal.
      { code: 'const o = { fontSize: dense ? small : large };' },
      // `text-[…]` that is not a size at all.
      { code: 'const a = <span className="text-[#1c1917]" />;' },
      { code: 'const a = <span className="text-[length:theme(fontSize.sm)]" />;' },
      // Sizes elsewhere in the style object are this rule\'s business only for type.
      { code: 'const o = { width: 280, lineHeight: 19 };' },
    ],
    invalid: [
      {
        // React reads a bare number as CSS pixels.
        code: 'const o = { fontSize: 13 };',
        errors: [{ messageId: 'pxFontSize' }],
      },
      {
        code: "const o = { fontSize: '13px' };",
        errors: [{ messageId: 'pxFontSize' }],
      },
      {
        // Every absolute unit, not only `px`.
        code: "const o = { fontSize: '10pt' };",
        errors: [{ messageId: 'pxFontSize' }],
      },
      {
        // A quoted key is the same property.
        code: "const o = { 'fontSize': 12 };",
        errors: [{ messageId: 'pxFontSize' }],
      },
      {
        // The MUI-shim `sx` prop lands in the same inline style.
        code: "const a = <Typography sx={{ fontSize: '11px' }} />;",
        errors: [{ messageId: 'pxFontSize' }],
      },
      {
        // The SVG presentation attribute.
        code: 'const a = <text fontSize={22} />;',
        errors: [{ messageId: 'pxFontSize' }],
      },
      {
        code: 'const a = <span className="text-[13px] font-medium" />;',
        errors: [{ messageId: 'arbitraryTextSize' }],
      },
      {
        // An off-scale `rem` is still off the scale.
        code: 'const a = <span className="text-[0.65rem]" />;',
        errors: [{ messageId: 'arbitraryTextSize' }],
      },
      {
        // Behind a variant, and inside a template literal.
        code: 'const a = <span className={`base ${x} md:text-[11px]`} />;',
        errors: [{ messageId: 'arbitraryTextSize' }],
      },
      {
        // Both spellings on one element are both reported.
        code: 'const a = <span style={{ fontSize: 9 }} className="text-[10px]" />;',
        errors: [{ messageId: 'pxFontSize' }, { messageId: 'arbitraryTextSize' }],
      },
    ],
  });

  it('names the seam to use in its message, not just the mistake', () => {
    // The rule is read by whoever trips it, and the reason a size is frozen is the part
    // that is not obvious — an exemption exists, and the message says where it lives.
    const { messages } = rule.meta;

    expect(messages.pxFontSize).toContain('DESIGN.md §3.2');
    expect(messages.pxFontSize).toContain('editorTypography');
    expect(messages.pxFontSize).toContain('svgTypography');
    expect(messages.pxFontSize).toContain('canvas-theme');
    expect(messages.arbitraryTextSize).toContain('text-2xs');
  });
});
