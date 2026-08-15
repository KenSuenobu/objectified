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
