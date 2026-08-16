/**
 * Static reader for the Hive design-token layer in `src/app/globals.css` (HIVE-1.1, #5274).
 *
 * jsdom compiles no stylesheet and resolves no `var()`, so a Jest suite cannot ask a
 * browser whether `--bg-canvas` has a value. This module answers the same question from
 * the source instead: it parses the two blocks that own the token layer — the Tailwind
 * `@theme` block and the unlayered `:root` alias block — and walks `var()` chains until
 * it reaches a literal, exactly the way the cascade would.
 *
 * It also encodes the two structural rules the token layer depends on, both of which are
 * silent-failure modes rather than crashes:
 *
 *   • Tailwind emits `@theme` into `@layer theme`, which loses to every unlayered rule.
 *     A name declared in *both* `@theme` and `:root` is therefore pinned to the `:root`
 *     value forever, and the per-theme swaps of HIVE-1.2 would never take effect.
 *   • Tailwind tree-shakes theme variables no generated utility references, so only
 *     `@theme static` guarantees that every token actually reaches `:root` in the browser.
 *
 * Colour arithmetic reuses `relativeLuminance` from `tailwind-contrast`, which is the
 * repo's WCAG implementation; only hex parsing is added here, because the Hive palette is
 * authored as hex rather than as Tailwind's OKLCH.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relativeLuminance, type Rgb } from './tailwind-contrast';

/** Absolute path of the stylesheet that owns the token layer. */
export const GLOBALS_CSS_PATH = join(__dirname, '..', '..', 'src', 'app', 'globals.css');

/** Absolute path of the design authority the token values are ported from. */
export const DESIGN_DOC_PATH = join(__dirname, '..', '..', '..', 'docs', 'mockups', 'DESIGN.md');

/** Marker comment opening a region where raw hex literals are permitted. */
const HEX_ALLOW_START = 'hex-allow-start';

/** Marker comment closing a region where raw hex literals are permitted. */
const HEX_ALLOW_END = 'hex-allow-end';

/** A `#rgb`, `#rrggbb` or `#rrggbbaa` literal. */
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/;

/**
 * A value that is nothing but `var(--name)` — a pure alias.
 *
 * A `var()` carrying a fallback (`var(--x, sans-serif)`) is deliberately *not* matched:
 * it already states its own resolved value, so the chain stops there.
 */
const PURE_ALIAS = /^var\(\s*(--[a-zA-Z0-9-]+)\s*\)$/;

/** @returns The raw text of `src/app/globals.css`. */
export function readGlobalsCss(): string {
  return readFileSync(GLOBALS_CSS_PATH, 'utf8');
}

/**
 * Blank out `/* … *\/` comments while preserving line and column positions.
 *
 * Comments carry issue references such as `#5274` that would otherwise read as hex
 * literals, and TODO notes that name tokens the block does not actually declare.
 *
 * @param css Stylesheet source.
 * @returns The same text with every comment replaced by whitespace of equal shape.
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * Extract the declarations of the first top-level block whose prelude matches.
 *
 * @param css Stylesheet source (comments are stripped internally).
 * @param prelude Exact block prelude, e.g. `@theme static` or `:root`.
 * @returns Custom-property name to declared value, in source order.
 * @throws If no block with that prelude exists.
 */
export function parseBlock(css: string, prelude: string): Map<string, string> {
  const source = stripCssComments(css);
  const opening = source.indexOf(`${prelude} {`);
  if (opening === -1) {
    throw new Error(`globals.css has no \`${prelude} { … }\` block`);
  }

  let depth = 0;
  let end = -1;
  for (let i = opening; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(`\`${prelude}\` block in globals.css is never closed`);
  }

  const declarations = new Map<string, string>();
  const body = source.slice(source.indexOf('{', opening) + 1, end);
  for (const statement of body.split(';')) {
    const match = /^\s*(--[a-zA-Z0-9-]+)\s*:\s*([\s\S]+)$/.exec(statement);
    if (match) declarations.set(match[1], match[2].trim().replace(/\s+/g, ' '));
  }
  return declarations;
}

/** The two blocks that make up the token layer, parsed once per call. */
export interface TokenLayer {
  /** Declarations inside `@theme static` — the Tailwind-facing token definitions. */
  theme: Map<string, string>;
  /** Declarations inside the unlayered `:root` block — hive-name and legacy aliases. */
  root: Map<string, string>;
}

/**
 * Parse both halves of the token layer out of `globals.css`.
 *
 * @param css Stylesheet source. Defaults to the real `globals.css`.
 * @returns The `@theme static` and `:root` declaration maps.
 */
export function readTokenLayer(css: string = readGlobalsCss()): TokenLayer {
  return { theme: parseBlock(css, '@theme static'), root: parseBlock(css, ':root') };
}

/**
 * Resolve a token to a literal value by following its `var()` chain.
 *
 * `:root` is consulted first because it is unlayered and therefore outranks `@theme`,
 * which is what the browser does.
 *
 * @param name Custom-property name, including the leading `--`.
 * @param layer Parsed token layer.
 * @returns The literal the token ultimately resolves to.
 * @throws If the token is undeclared, or its chain dangles or loops.
 */
export function resolveToken(name: string, layer: TokenLayer): string {
  const seen = new Set<string>();
  let current = name;

  for (;;) {
    if (seen.has(current)) {
      throw new Error(`Token ${name} resolves through a cycle at ${current}`);
    }
    seen.add(current);

    const value = layer.root.get(current) ?? layer.theme.get(current);
    if (value === undefined) {
      throw new Error(
        seen.size === 1
          ? `Token ${name} is not declared in @theme or :root`
          : `Token ${name} references ${current}, which is not declared`,
      );
    }

    // Anything that is not a bare alias — a literal, or a composite such as a shadow that
    // embeds a `var()` — is already the resolved value.
    const alias = PURE_ALIAS.exec(value);
    if (!alias) return value;
    current = alias[1];
  }
}

/** One raw hex literal found outside every allow-listed region. */
export interface UnfencedHex {
  /** 1-based line number in `globals.css`. */
  line: number;
  /** The offending source line, trimmed. */
  text: string;
}

/**
 * Find raw hex literals that sit outside a `hex-allow-start` / `hex-allow-end` fence.
 *
 * @param css Stylesheet source. Defaults to the real `globals.css`.
 * @returns Every unfenced occurrence, in source order.
 */
export function findUnfencedHex(css: string = readGlobalsCss()): UnfencedHex[] {
  const rawLines = css.split('\n');
  const codeLines = stripCssComments(css).split('\n');
  const offenders: UnfencedHex[] = [];
  let fenced = false;

  rawLines.forEach((raw, index) => {
    if (raw.includes(HEX_ALLOW_START)) {
      fenced = true;
      return;
    }
    if (raw.includes(HEX_ALLOW_END)) {
      fenced = false;
      return;
    }
    if (fenced) return;
    if (HEX_LITERAL.test(codeLines[index])) {
      offenders.push({ line: index + 1, text: raw.trim() });
    }
  });

  return offenders;
}

/**
 * Token names listed in the colour table of `DESIGN.md` §3.1 — the design authority.
 *
 * Rows spell a family either explicitly (`` `--fg` / `--fg-muted` ``) or as bases plus
 * shared suffixes (`` `--ok` `--warn` `--danger` (+ `-soft`, `-fg`) ``); the second form
 * is expanded here so the caller always sees fully-qualified names.
 *
 * @param markdown `DESIGN.md` source. Defaults to the real document.
 * @returns Every token name §3.1 declares, deduplicated and sorted.
 */
export function designDocColorTokens(
  markdown: string = readFileSync(DESIGN_DOC_PATH, 'utf8'),
): string[] {
  const section = /###\s*3\.1[^\n]*\n([\s\S]*?)\n###\s/.exec(markdown);
  if (!section) throw new Error('DESIGN.md has no §3.1 colour-token section');

  const tokens = new Set<string>();
  for (const row of section[1].split('\n')) {
    if (!row.trimStart().startsWith('|')) continue;
    const cell = row.split('|')[1] ?? '';
    const bases = [...cell.matchAll(/`(--[a-z0-9-]+)`/g)].map((m) => m[1]);
    if (bases.length === 0) continue;
    const suffixes = [...cell.matchAll(/`(-[a-z0-9-]+)`/g)]
      .map((m) => m[1])
      .filter((suffix) => !suffix.startsWith('--'));

    for (const base of bases) {
      tokens.add(base);
      for (const suffix of suffixes) tokens.add(`${base}${suffix}`);
    }
  }
  return [...tokens].sort();
}

/**
 * The DESIGN.md §3.2 type scale, as step name → size in CSS pixels.
 *
 * §3.2 writes the scale as one inline code span —
 * `` `2xs 11 · xs 12 · sm 13 · md 14 (body) · …` `` — so the document stays the authority
 * for the numbers and `tests/hive-type-scale.test.ts` cannot drift from it. Parenthesised
 * notes (`(body)`, `(page title)`) are annotations and are ignored.
 *
 * @param markdown `DESIGN.md` source. Defaults to the real document.
 * @returns Step name (without the `--fs-` prefix) to pixel size, in document order.
 * @throws If §3.2 carries no recognisable scale.
 */
export function designDocTypeScale(
  markdown: string = readFileSync(DESIGN_DOC_PATH, 'utf8'),
): Map<string, number> {
  const section = /###\s*3\.2[^\n]*\n([\s\S]*?)\n###\s/.exec(markdown);
  if (!section) throw new Error('DESIGN.md has no §3.2 typography section');

  const span = /`((?:\s*\d*[a-z]+ \d+(?:\s*\([^)]*\))?\s*·?)+)`/.exec(section[1]);
  if (!span) throw new Error('DESIGN.md §3.2 has no `2xs 11 · xs 12 · …` scale span');

  const scale = new Map<string, number>();
  for (const step of span[1].split('·')) {
    const match = /^\s*(\d*[a-z]+)\s+(\d+)/.exec(step);
    if (match) scale.set(match[1], Number(match[2]));
  }
  if (scale.size === 0) throw new Error('DESIGN.md §3.2 scale span parsed to nothing');
  return scale;
}

/** The DESIGN.md §3.5 icon vocabulary. */
export interface DesignDocIconSizes {
  /** Size in dense UI, in CSS pixels. */
  dense: number;
  /** Size in the rail, in CSS pixels. */
  rail: number;
  /** Size inside a button, in CSS pixels. */
  button: number;
  /** Stroke width every icon is drawn with. */
  strokeWidth: number;
}

/**
 * Parse §3.5's one-sentence icon rule — "Lucide, 16 px in dense UI, 18 px in the rail,
 * 15 px in buttons, stroke 1.75."
 *
 * @param markdown `DESIGN.md` source. Defaults to the real document.
 * @returns The three sizes and the stroke width.
 * @throws If §3.5 no longer states them.
 */
export function designDocIconSizes(
  markdown: string = readFileSync(DESIGN_DOC_PATH, 'utf8'),
): DesignDocIconSizes {
  const section = /###\s*3\.5[^\n]*\n([\s\S]*?)\n(?:###|##)\s/.exec(markdown);
  if (!section) throw new Error('DESIGN.md has no §3.5 iconography section');

  const read = (pattern: RegExp, what: string): number => {
    const match = pattern.exec(section[1]);
    if (!match) throw new Error(`DESIGN.md §3.5 no longer states the ${what}`);
    return Number(match[1]);
  };

  return {
    dense: read(/(\d+(?:\.\d+)?)\s*px in dense UI/, 'dense size'),
    rail: read(/(\d+(?:\.\d+)?)\s*px in the rail/, 'rail size'),
    button: read(/(\d+(?:\.\d+)?)\s*px in buttons/, 'button size'),
    strokeWidth: read(/stroke\s+(\d+(?:\.\d+)?)/, 'stroke width'),
  };
}

/**
 * Parse a `#rgb`, `#rrggbb` or `#rrggbbaa` literal into sRGB channels.
 *
 * @param hex Colour literal, with the leading `#`.
 * @returns The 8-bit sRGB channels; any alpha component is ignored.
 * @throws If the literal is not a hex colour.
 */
export function hexToRgb(hex: string): Rgb {
  const digits = /^#([0-9a-fA-F]{3,8})$/.exec(hex.trim());
  if (!digits) throw new Error(`Not a hex colour: ${hex}`);

  const body = digits[1];
  const expanded = body.length <= 4 ? [...body].map((d) => d + d).join('') : body;
  return {
    r: parseInt(expanded.slice(0, 2), 16),
    g: parseInt(expanded.slice(2, 4), 16),
    b: parseInt(expanded.slice(4, 6), 16),
  };
}

/**
 * WCAG 2.x contrast ratio between two opaque colours.
 *
 * @param foreground Text or glyph colour.
 * @param background Colour painted behind it.
 * @returns The ratio, from 1 (identical) to 21 (black on white).
 */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

/* ==========================================================================
   Per-theme token swaps (HIVE-1.2, #5275)
   ========================================================================== */

/** One top-level rule of the stylesheet, comments already stripped. */
export interface CssRule {
  /** Everything before the opening brace, whitespace-collapsed. */
  prelude: string;
  /** Everything between the braces. */
  body: string;
  /** 1-based line the prelude starts on, for readable failure messages. */
  line: number;
}

/**
 * Walk the stylesheet's top-level rules.
 *
 * Nested rules (inside `@media`, `@keyframes`, …) are deliberately not descended into:
 * the theme blocks this module reasons about are all top level, and flattening would make
 * "no rule outside a theme block declares a token" impossible to state.
 *
 * @param css Stylesheet source. Defaults to the real `globals.css`.
 * @returns Every top-level rule, in source order. At-statements without a body
 *          (`@import`, `@source`, …) are skipped.
 */
export function topLevelRules(css: string = readGlobalsCss()): CssRule[] {
  const source = stripCssComments(css);
  const rules: CssRule[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open === -1) break;

    // An at-statement terminated by `;` before the next `{` has no body of its own.
    const semicolon = source.indexOf(';', cursor);
    if (semicolon !== -1 && semicolon < open) {
      cursor = semicolon + 1;
      continue;
    }

    let depth = 0;
    let close = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) throw new Error(`Unclosed rule at offset ${open} in globals.css`);

    const raw = source.slice(cursor, open);
    const preludeStart = cursor + (raw.length - raw.trimStart().length);
    rules.push({
      prelude: raw.trim().replace(/\s+/g, ' '),
      body: source.slice(open + 1, close),
      line: source.slice(0, preludeStart).split('\n').length,
    });
    cursor = close + 1;
  }

  return rules;
}

/**
 * Split a rule body into declarations.
 *
 * Unlike {@link parseBlock} this keeps *every* property, not just custom ones, which is
 * what lets a caller prove a theme block declares nothing but tokens.
 *
 * @param body Text between a rule's braces.
 * @returns Property name to value, in source order.
 */
export function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const statement of body.split(';')) {
    const match = /^\s*([-a-zA-Z][-a-zA-Z0-9]*)\s*:\s*([\s\S]+)$/.exec(statement);
    if (match) declarations.set(match[1], match[2].trim().replace(/\s+/g, ' '));
  }
  return declarations;
}

/** One `html[data-theme="…"]` block — a theme's entire definition. */
export interface ThemeBlock {
  /** Resolved theme id, e.g. `nord`. */
  id: string;
  /** The rule's full prelude, including any companion selectors. */
  prelude: string;
  /** Everything the block declares, tokens and `color-scheme` alike. */
  declarations: Map<string, string>;
  /** 1-based line the block starts on. */
  line: number;
}

/**
 * Collect the per-theme token swaps.
 *
 * @param css Stylesheet source. Defaults to the real `globals.css`.
 * @returns Theme id to its block, in source order. `light` is absent by design — it is
 *          the `:root` default and has no block.
 */
export function readThemeBlocks(css: string = readGlobalsCss()): Map<string, ThemeBlock> {
  const blocks = new Map<string, ThemeBlock>();

  for (const rule of topLevelRules(css)) {
    const ids = [...rule.prelude.matchAll(/\[data-theme="([a-z-]+)"\]/g)].map((match) => match[1]);
    if (ids.length === 0) continue;

    // A rule naming several themes (or scoping a component) is not a theme definition.
    const unique = [...new Set(ids)];
    if (unique.length !== 1 || !/^html\[data-theme="[a-z-]+"\]/.test(rule.prelude)) continue;

    blocks.set(unique[0], {
      id: unique[0],
      prelude: rule.prelude,
      declarations: parseDeclarations(rule.body),
      line: rule.line,
    });
  }

  return blocks;
}

/**
 * Resolve a token as it computes *under a theme*.
 *
 * Look-up order mirrors the cascade: the theme block outranks the unlayered `:root`
 * aliases, which outrank `@theme` (`@layer theme` loses to everything unlayered).
 *
 * @param name Custom-property name, including the leading `--`.
 * @param layer Parsed token layer.
 * @param block The theme's block, or `undefined` for the `light` default.
 * @returns The literal the token resolves to under that theme.
 * @throws If the token is undeclared, or its chain dangles or loops.
 */
export function resolveThemeToken(name: string, layer: TokenLayer, block?: ThemeBlock): string {
  const seen = new Set<string>();
  let current = name;

  for (;;) {
    if (seen.has(current)) {
      throw new Error(`Token ${name} resolves through a cycle at ${current}`);
    }
    seen.add(current);

    const value = block?.declarations.get(current) ?? layer.root.get(current) ?? layer.theme.get(current);
    if (value === undefined) {
      throw new Error(
        seen.size === 1
          ? `Token ${name} is not declared in @theme, :root or [data-theme="${block?.id ?? 'light'}"]`
          : `Token ${name} references ${current}, which is not declared`,
      );
    }

    const alias = PURE_ALIAS.exec(value);
    if (!alias) return value;
    current = alias[1];
  }
}

/**
 * Alpha channel of a colour literal.
 *
 * @param color An `rgb()` / `rgba()` literal, or a hex literal with or without alpha.
 * @returns The alpha, `1` when the literal is opaque.
 * @throws If the literal is neither hex nor `rgb()`/`rgba()`.
 */
export function alphaOf(color: string): number {
  const rgba = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  if (rgba) {
    const parts = rgba[1].split(/[,/]/).map((part) => part.trim());
    return parts.length > 3 ? Number(parts[3]) : 1;
  }

  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(color.trim());
  if (!hex) throw new Error(`Not a colour literal: ${color}`);
  if (hex[1].length === 4) return parseInt(hex[1][3] + hex[1][3], 16) / 255;
  if (hex[1].length === 8) return parseInt(hex[1].slice(6, 8), 16) / 255;
  return 1;
}

/**
 * Flatten a translucent colour onto an opaque backdrop.
 *
 * Border tokens are deliberately translucent so one value works on every surface; a
 * contrast check therefore has to composite them first, the way the compositor does.
 *
 * @param color The (possibly translucent) foreground literal.
 * @param backdrop The opaque colour painted behind it.
 * @returns The resulting opaque sRGB channels.
 */
export function compositeOver(color: string, backdrop: Rgb): Rgb {
  const alpha = alphaOf(color);
  const rgba = /^rgba?\(([^)]+)\)$/.exec(color.trim());
  const channels: Rgb = rgba
    ? (() => {
        const [r, g, b] = rgba[1].split(/[,/]/).map((part) => Number(part.trim()));
        return { r, g, b };
      })()
    : hexToRgb(color);

  return {
    r: channels.r * alpha + backdrop.r * (1 - alpha),
    g: channels.g * alpha + backdrop.g * (1 - alpha),
    b: channels.b * alpha + backdrop.b * (1 - alpha),
  };
}
