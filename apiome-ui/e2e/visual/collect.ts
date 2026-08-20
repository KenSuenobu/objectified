/**
 * The in-browser collector of the visual-parity harness (HIVE-10.1, #5337).
 *
 * `collectRaw` is handed to `page.evaluate`, so Playwright serialises its **source text** and
 * runs it in the page with no closure and no imports. Everything it needs therefore arrives
 * in `config`, and every helper it uses is declared inside it. Keep it that way: a reference
 * to anything at module scope compiles fine and fails at runtime with a bare `ReferenceError`
 * inside the browser.
 *
 * It is deliberately a *dumb* reader. It measures pixels, colours and boxes and returns them
 * raw; snapping those numbers onto the token ladders, aggregating them and scoring them all
 * happen in Node (`signature.ts`, `score.ts`) where they are ordinary pure functions with
 * ordinary unit tests.
 */

/** A measured box, in CSS pixels, relative to the page scope's top-left corner. */
export interface RawBox {
  /** Offset from the scope's left edge. */
  x: number;
  /** Offset from the scope's top edge. */
  y: number;
  /** Border-box width. */
  width: number;
  /** Border-box height. */
  height: number;
}

/** A landmark of the page chrome as the browser laid it out. */
export interface RawLandmark {
  /** Its border box, relative to the page scope. */
  box: RawBox;
  /** Its computed `font-size`, in CSS pixels. */
  fontSizePx: number;
  /** Its computed `font-weight`, as a number. */
  fontWeight: number;
}

/** One text-bearing element: the type it is set in and how much text it carries. */
export interface RawText {
  /** Computed `font-size`, in CSS pixels. */
  fontSizePx: number;
  /** Computed `font-weight`, as a number. */
  fontWeight: number;
  /** Computed `color`, in the browser's canonical serialisation. */
  colour: string;
  /** Number of visible characters the element owns directly (not via descendants). */
  chars: number;
}

/** One card-sized box painted on `--bg-surface`. */
export interface RawSurface {
  /** Computed `border-top-left-radius`, in CSS pixels. */
  radiusPx: number;
  /** Computed `border-top-width`, in CSS pixels. */
  borderPx: number;
}

/** Everything one side of the comparison reports about one page. */
export interface RawSignature {
  /** Resolved value of every requested token, canonicalised by the browser. */
  tokens: Record<string, string>;
  /** The page scope's own border box. */
  scope: { width: number; height: number };
  /** Landmark id → what was found, or `null` when the page has no such landmark. */
  landmarks: Record<string, RawLandmark | null>;
  /** Every text-bearing element in the scope. */
  text: RawText[];
  /** Every card-sized surface in the scope. */
  surfaces: RawSurface[];
  /** Every non-zero `padding-top` and `padding-left` in the scope. */
  paddings: number[];
  /** The laid-out height of every control (button, input, select, textarea). */
  controls: number[];
  /** Every `row-gap` a stacking container declares, and every non-zero top margin. */
  gaps: number[];
  /** The column count of every table in the scope. */
  tables: number[];
}

/** What `collectRaw` needs to know, since it cannot import any of it. */
export interface CollectConfig {
  /** Selector for the page region to measure. */
  scopeSelector: string;
  /** Landmark id → selector, for this side. */
  landmarks: Record<string, string>;
  /** Names of the custom properties to resolve (without the leading `--`). */
  tokens: string[];
  /** Which of `tokens` resolve to colours rather than lengths. */
  colourTokens: string[];
  /**
   * Extra padding, in CSS pixels, to add to every already-padded box before measuring.
   *
   * This is the harness's self-test hook and nothing else: #5337 asks for proof that a
   * deliberate 20 px padding regression is *caught*, and the only honest proof is to inject
   * one into a page that otherwise passes and watch the score fall through the gate. It is
   * applied in one pass before any box is read, so the layout the collector measures is the
   * settled, regressed one.
   */
  paddingDeltaPx?: number;
}

/**
 * Measure one page.
 *
 * Runs inside the browser. Throws when the scope selector matches nothing, which is a harness
 * bug (a bad route map entry or a fixture that never mounted) rather than a parity failure,
 * and is much easier to read as an exception than as a score of zero.
 *
 * @param config Everything the collector needs; see {@link CollectConfig}.
 * @returns The raw measurement of the page, ready for `buildSignature`.
 */
export function collectRaw(config: CollectConfig): RawSignature {
  const root = document.querySelector(config.scopeSelector) as HTMLElement | null;
  if (!root) {
    throw new Error(`visual-parity: no element matched scope selector "${config.scopeSelector}"`);
  }

  /** Round to two decimals so sub-pixel noise never reaches the report. */
  const px = (value: number): number => Math.round(value * 100) / 100;

  /** Below this a "control" is a visually-hidden input, not something anybody sized. */
  const MINIMUM_CONTROL_PX = 8;

  /** Above this a "gap" is a layout artefact — a sticky header, an absolute box — not rhythm. */
  const MAXIMUM_GAP_PX = 200;

  /** Below these a box painted on `--bg-surface` is a control or a chip, not a card. */
  const MINIMUM_CARD_WIDTH_PX = 200;
  const MINIMUM_CARD_HEIGHT_PX = 60;

  /** Is this element laid out at all? Zero-box elements carry no design information. */
  const laidOut = (element: Element): boolean => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  // ---- 1. Resolve the token ladder through a probe -------------------------------------
  // `getPropertyValue` returns what the stylesheet *wrote* (`#0f172a`, `1rem`); a computed
  // style returns what the browser *resolved* (`rgb(15, 23, 42)`, `16px`). Only the second
  // can be compared with a measurement, so every token is pushed through a probe element and
  // read back.
  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.left = '-99999px';
  probe.style.top = '0';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  root.appendChild(probe);

  const colourNames: Record<string, boolean> = {};
  for (const name of config.colourTokens) colourNames[name] = true;

  /** A value no token can legitimately resolve to, used to detect "not declared". */
  const SENTINEL_COLOUR = 'rgb(1, 2, 3)';
  const SENTINEL_LENGTH = '0px';

  const tokens: Record<string, string> = {};
  for (const name of config.tokens) {
    if (colourNames[name]) {
      probe.style.color = SENTINEL_COLOUR;
      probe.style.color = `var(--${name})`;
      const resolved = getComputedStyle(probe).color;
      tokens[name] = resolved === SENTINEL_COLOUR ? '' : resolved;
    } else {
      probe.style.width = SENTINEL_LENGTH;
      probe.style.width = `var(--${name})`;
      const resolved = getComputedStyle(probe).width;
      tokens[name] = resolved === SENTINEL_LENGTH ? '' : resolved;
    }
  }
  probe.remove();

  const surfaceBackground = tokens['bg-surface'] || '';

  // ---- 2. Find the cards, the paddings, and (for the self-test) regress them ------------
  // A "surface" is what both design systems mean by a card: a rounded box painted on
  // `--bg-surface` that is big enough to hold content. Neither side can be recognised by
  // class name — the mockups write `.card`, the app composes Tailwind utilities — but both
  // resolve to the same token, so the paint is the one hook that works on both. The size
  // floor is what keeps a switch knob, a badge and a text input out: all three are painted on
  // that same token, and none of them is a card.
  const all = Array.prototype.slice.call(root.querySelectorAll('*')) as HTMLElement[];
  const surfaceElements: HTMLElement[] = [];
  const paddedElements: HTMLElement[] = [];
  for (const element of all) {
    if (!laidOut(element)) continue;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (
      surfaceBackground &&
      style.backgroundColor === surfaceBackground &&
      parseFloat(style.borderTopLeftRadius) > 0 &&
      rect.width >= MINIMUM_CARD_WIDTH_PX &&
      rect.height >= MINIMUM_CARD_HEIGHT_PX
    ) {
      surfaceElements.push(element);
    }
    if (parseFloat(style.paddingTop) > 0 || parseFloat(style.paddingLeft) > 0) {
      paddedElements.push(element);
    }
  }

  const delta = config.paddingDeltaPx || 0;
  if (delta > 0) {
    // One pass to mutate, so every box read below is measured against the settled layout.
    for (const element of paddedElements) {
      const style = getComputedStyle(element);
      const grow = (value: string): string =>
        parseFloat(value) > 0 ? `${parseFloat(value) + delta}px` : value;
      element.style.paddingTop = grow(style.paddingTop);
      element.style.paddingRight = grow(style.paddingRight);
      element.style.paddingBottom = grow(style.paddingBottom);
      element.style.paddingLeft = grow(style.paddingLeft);
    }
  }

  const surfaces: RawSurface[] = surfaceElements.map((element) => {
    const style = getComputedStyle(element);
    return {
      radiusPx: px(parseFloat(style.borderTopLeftRadius) || 0),
      borderPx: px(parseFloat(style.borderTopWidth) || 0),
    };
  });

  // The page's padding vocabulary. Both design systems build every padding from the spacing
  // scale, so this is the measurement that reads a "20 px roomier" regression directly.
  const paddings: number[] = [];
  for (const element of paddedElements) {
    const style = getComputedStyle(element);
    const top = parseFloat(style.paddingTop) || 0;
    const left = parseFloat(style.paddingLeft) || 0;
    if (top > 0) paddings.push(px(top));
    if (left > 0) paddings.push(px(left));
  }

  // ---- 3. The scope and its landmarks --------------------------------------------------
  const scopeRect = root.getBoundingClientRect();
  const landmarks: Record<string, RawLandmark | null> = {};
  for (const id of Object.keys(config.landmarks)) {
    const element = root.querySelector(config.landmarks[id]) as HTMLElement | null;
    if (!element || !laidOut(element)) {
      landmarks[id] = null;
      continue;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    landmarks[id] = {
      box: {
        x: px(rect.left - scopeRect.left),
        y: px(rect.top - scopeRect.top),
        width: px(rect.width),
        height: px(rect.height),
      },
      fontSizePx: px(parseFloat(style.fontSize) || 0),
      fontWeight: Number(style.fontWeight) || 400,
    };
  }

  // ---- 4. Type and ink ------------------------------------------------------------------
  // Only text an element owns *directly* counts, so a wrapper never claims its children's
  // words and inflate the weight of its own font size.
  const text: RawText[] = [];
  for (const element of all) {
    let chars = 0;
    for (const node of Array.prototype.slice.call(element.childNodes) as ChildNode[]) {
      if (node.nodeType === 3) chars += (node.nodeValue || '').trim().length;
    }
    if (chars === 0 || !laidOut(element)) continue;
    const style = getComputedStyle(element);
    text.push({
      fontSizePx: px(parseFloat(style.fontSize) || 0),
      fontWeight: Number(style.fontWeight) || 400,
      colour: style.color,
      chars,
    });
  }

  // ---- 5. Controls ----------------------------------------------------------------------
  const controlSelector =
    'button, [role="button"], input:not([type="hidden"]), select, textarea, a.btn';
  const controls: number[] = [];
  for (const element of Array.prototype.slice.call(
    root.querySelectorAll(controlSelector)
  ) as HTMLElement[]) {
    if (!laidOut(element)) continue;
    const height = px(element.getBoundingClientRect().height);
    // A visually-hidden checkbox behind a styled one is a hairline box, not a control anybody
    // sizes; counting it would report the app as full of off-scale controls.
    if (height < MINIMUM_CONTROL_PX) continue;
    controls.push(height);
  }

  // ---- 6. Vertical rhythm ---------------------------------------------------------------
  // The *authored* rhythm, not the measured distance between boxes. A distance read off two
  // bounding rectangles carries the overhang of whatever line box happens to sit at the edge,
  // which is how a page built entirely from the 4 px scale reports gaps of 1 px and 5 px. The
  // `row-gap` a flex or grid container declares, and the top margin a block declares, are the
  // numbers a designer actually chose — and both sides choose them from the same scale.
  const gaps: number[] = [];
  for (const element of all) {
    if (!laidOut(element)) continue;
    const style = getComputedStyle(element);
    const stacks = style.display === 'flex' || style.display === 'grid';
    if (stacks && (Array.prototype.slice.call(element.children) as HTMLElement[]).some(laidOut)) {
      const rowGap = parseFloat(style.rowGap);
      if (rowGap > 0 && rowGap <= MAXIMUM_GAP_PX) gaps.push(px(rowGap));
    }
    const marginTop = parseFloat(style.marginTop);
    if (marginTop > 0 && marginTop <= MAXIMUM_GAP_PX) gaps.push(px(marginTop));
  }

  // ---- 7. Tables ------------------------------------------------------------------------
  const tables: number[] = [];
  for (const table of Array.prototype.slice.call(
    root.querySelectorAll('table')
  ) as HTMLTableElement[]) {
    if (!laidOut(table)) continue;
    const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
    tables.push(headerRow ? headerRow.children.length : 0);
  }

  return {
    tokens,
    scope: { width: px(scopeRect.width), height: px(scopeRect.height) },
    landmarks,
    text,
    surfaces,
    paddings,
    controls,
    gaps,
    tables,
  };
}
