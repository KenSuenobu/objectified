/**
 * Local ESLint rules for the Hive design language (HIVE-1.6, #5279).
 *
 * The `rem` audit only stays audited if something fails when a frozen size comes back.
 * `tests/hive-rem-audit.test.ts` scans the tree for what is there today; this plugin is
 * the half that catches a size *as it is typed*, in the editor, with the reason attached.
 *
 * Registered from `eslint.config.mjs`, scoped to the directories the audit covers.
 */

/** Absolute CSS length units — the ones that do not follow the reader's font-size setting. */
const ABSOLUTE_UNITS = ['px', 'pt', 'pc', 'cm', 'mm', 'in', 'Q'];

/**
 * A Tailwind arbitrary font-size utility with an explicit length: `text-[13px]`,
 * `md:text-[0.65rem]`, `hover:text-[1em]`.
 *
 * `rem` and `em` are matched alongside the absolute units on purpose. They scale, but an
 * arbitrary `text-[0.65rem]` is a size *off* the DESIGN.md §3.2 scale, which is the other
 * half of what this ticket removed — the scale is the vocabulary, not just the unit.
 * Anything that is not a bare number and unit (`text-[var(--fs-sm)]`, `text-[#1c1917]`,
 * `text-[length:theme(...)]`) is left alone.
 */
const ARBITRARY_TEXT_SIZE = /\btext-\[\d*\.?\d+(px|pt|pc|cm|mm|in|Q|rem|em)\]/;

/** The `sm` step of the Hive scale, used in the messages as a worked example. */
const EXAMPLE = 'text-sm / var(--fs-sm)';

const messages = {
  pxFontSize:
    "Hard-coded font size '{{value}}'. Use the DESIGN.md §3.2 scale ({{example}}) so the " +
    'font-size preference reaches this text. Genuinely physical type — Monaco, an SVG ' +
    'coordinate system, a react-flow node — imports its size from ' +
    "'components/ui/code/editorTypography', 'components/ui/svgTypography' or " +
    "'components/ade/canvas/canvas-theme'.",
  arbitraryTextSize:
    "Arbitrary font size '{{value}}' in a class name. Use the DESIGN.md §3.2 scale " +
    '(text-2xs · text-xs · text-sm · text-base · text-lg · text-xl · text-2xl · text-3xl · ' +
    'text-4xl · text-5xl), which is already pointed at the Hive tokens.',
};

/**
 * Report every arbitrary font-size utility inside one string of class names.
 *
 * @param context The rule context.
 * @param node The `Literal` or `TemplateElement` the text came from.
 * @param text The raw string contents.
 */
function checkClassText(context, node, text) {
  const match = ARBITRARY_TEXT_SIZE.exec(text);
  if (match) {
    context.report({ node, messageId: 'arbitraryTextSize', data: { value: match[0] } });
  }
}

/**
 * `no-px-typography` — no frozen font size in a component.
 *
 * Flags three spellings of the same mistake:
 *
 *   1. `style={{ fontSize: 13 }}` — a bare number is CSS pixels in React.
 *   2. `style={{ fontSize: '13px' }}` — and any other absolute unit.
 *   3. `className="text-[13px]"` — a Tailwind arbitrary size, in a string or a template.
 *
 * A `fontSize` whose value is an identifier, a member expression or a `var()` string is
 * accepted: it has already been routed through a named seam, which is where the three
 * genuinely physical exemptions live.
 */
const noPxTypography = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow hard-coded font sizes; use the DESIGN.md §3.2 type scale so the ' +
        'font-size preference scales the interface.',
    },
    schema: [],
    messages,
  },
  create(context) {
    /**
     * Report a `fontSize` value node when it freezes the size.
     *
     * @param valueNode The expression assigned to `fontSize`.
     */
    const checkFontSizeValue = (valueNode) => {
      if (!valueNode || valueNode.type !== 'Literal') return;
      const { value } = valueNode;
      if (typeof value === 'number') {
        context.report({
          node: valueNode,
          messageId: 'pxFontSize',
          data: { value: String(value), example: EXAMPLE },
        });
        return;
      }
      if (typeof value !== 'string') return;
      const unit = ABSOLUTE_UNITS.find((u) => new RegExp(`^\\d*\\.?\\d+${u}$`).test(value.trim()));
      if (unit) {
        context.report({
          node: valueNode,
          messageId: 'pxFontSize',
          data: { value, example: EXAMPLE },
        });
      }
    };

    return {
      // `{ fontSize: … }` in an inline style, an `sx` object or an editor `options` object.
      Property(node) {
        const key = node.key;
        const name = key.type === 'Identifier' ? key.name : key.type === 'Literal' ? key.value : null;
        if (name !== 'fontSize') return;
        checkFontSizeValue(node.value);
      },

      // `<text fontSize={10}>` — the SVG presentation attribute.
      JSXAttribute(node) {
        if (node.name?.type !== 'JSXIdentifier' || node.name.name !== 'fontSize') return;
        const value = node.value;
        if (!value) return;
        checkFontSizeValue(value.type === 'JSXExpressionContainer' ? value.expression : value);
      },

      // `className="… text-[13px] …"`, including the static chunks of a template literal.
      Literal(node) {
        if (typeof node.value === 'string') checkClassText(context, node, node.value);
      },

      TemplateElement(node) {
        checkClassText(context, node, node.value.raw);
      },
    };
  },
};

// ---------------------------------------------------------------------------
// `hive/no-native-dialog` (HIVE-2.7, #5286)
// ---------------------------------------------------------------------------

/** The three browser dialogs, and the `useDialog()` member that replaces each. */
const NATIVE_DIALOGS = {
  confirm: 'confirm',
  prompt: 'prompt',
  alert: 'alert',
};

/** Objects a native dialog can be reached through. */
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'top', 'parent']);

const nativeDialogMessages = {
  nativeDialog:
    "Native '{{name}}()' dialog. Use `const {{{member}}} = useDialog()` from " +
    "'components/providers/DialogProvider' instead: the browser's box is unstyled, " +
    'unthemed, untranslatable and not announced as a dialog, so no theme, density or ' +
    'font-scale preference reaches it (HIVE-2.7, #5286).',
};

/**
 * Is `name` bound by something in scope, rather than being the browser global?
 *
 * `const { confirm } = useDialog()` and `import { alert } from …` both bind it, and both are
 * exactly what this rule is asking for — so a call through them must stay quiet. A global
 * has a variable with no definitions (or none at all), which is what separates the two.
 *
 * @param scope The scope the call sits in.
 * @param name The callee's identifier.
 * @returns `true` when the name resolves to a real binding.
 */
function isLocallyBound(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.variables.find((v) => v.name === name);
    if (variable) return variable.defs.length > 0;
  }
  return false;
}

/**
 * `no-native-dialog` — no `window.confirm`, `window.prompt` or `alert` in the app.
 *
 * The acceptance criterion of #5286 is a `grep` that finds nothing, which is a claim about
 * the tree at one moment. `tests/hive-native-dialog-audit.test.ts` re-checks the tree on
 * every run; this is the half that catches the call *as it is typed*, with the replacement
 * named in the message.
 *
 * Both spellings are flagged — through a global object (`window.confirm()`) and bare
 * (`confirm()`), the latter only when nothing in scope has bound the name.
 */
const noNativeDialog = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow the browser‑native confirm/prompt/alert dialogs; use the themed, ' +
        'focus-trapped `useDialog()` dialogs so every reader gets the same surface.',
    },
    schema: [],
    messages: nativeDialogMessages,
  },
  create(context) {
    /**
     * Report one offending call.
     *
     * @param node The `CallExpression`.
     * @param name The dialog's name.
     */
    const report = (node, name) => {
      context.report({
        node,
        messageId: 'nativeDialog',
        data: { name, member: NATIVE_DIALOGS[name] },
      });
    };

    return {
      CallExpression(node) {
        const callee = node.callee;

        // `window.confirm(…)`, `globalThis.alert(…)`, `self.prompt(…)`.
        if (callee.type === 'MemberExpression') {
          if (callee.computed || callee.property.type !== 'Identifier') return;
          const name = callee.property.name;
          if (!(name in NATIVE_DIALOGS)) return;
          if (callee.object.type !== 'Identifier') return;
          if (!GLOBAL_OBJECTS.has(callee.object.name)) return;
          report(node, name);
          return;
        }

        // Bare `confirm(…)` — the global, not a `useDialog()` member of the same name.
        if (callee.type !== 'Identifier') return;
        const name = callee.name;
        if (!(name in NATIVE_DIALOGS)) return;
        const scope = context.sourceCode.getScope(node);
        if (isLocallyBound(scope, name)) return;
        report(node, name);
      },
    };
  },
};

/*
 * CommonJS, deliberately: `eslint.config.mjs` imports this as ESM (Node hands back
 * `module.exports` as the default export), and `tests/eslint-hive-no-px-typography.test.ts`
 * drives the very same file through ESLint's `RuleTester` under Jest, which runs CommonJS.
 * One file, exercised by the tool and by the test — not a plugin and a copy of it.
 */
module.exports = {
  meta: { name: 'hive' },
  rules: {
    'no-px-typography': noPxTypography,
    'no-native-dialog': noNativeDialog,
  },
};
