import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import hive from "./eslint-rules/hive.js";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated and one-off scripts
    "coverage/**",
    "convert-mui-to-radix.js",
    // Import corpus fixtures: deliberately malformed by design, and never app code.
    // Also excluded from tsconfig.json, so `next build` does not type-check them.
    "examples/**",
  ]),
  {
    /*
     * The `rem` audit's lint backstop (HIVE-1.6, #5279).
     *
     * Scoped to the two trees the audit swept: every user-facing surface of the app.
     * `src/app/utils/**` is deliberately outside it — the PDF exporters there measure in
     * printer points, which is a physical unit by definition.
     *
     * The rule accepts any non-literal value, so the three documented exemptions (Monaco,
     * SVG coordinate systems, react-flow nodes) satisfy it simply by importing their size
     * from the module that owns it.
     */
    files: ["src/app/components/**/*.{ts,tsx}", "src/app/ade/**/*.{ts,tsx}"],
    plugins: { hive },
    rules: { "hive/no-px-typography": "error" },
  },
  {
    /*
     * The native-dialog backstop (HIVE-2.7, #5286).
     *
     * Scoped to the whole of `src` rather than the two design trees: `window.confirm` was
     * last found in the admin console, which is outside them, and the acceptance criterion
     * is that the *app* has none left.
     */
    files: ["src/**/*.{ts,tsx}"],
    plugins: { hive },
    rules: { "hive/no-native-dialog": "error" },
  },
]);

export default eslintConfig;
