# Visual parity against the mockups (HIVE-10.1, #5337)

The Hive redesign's bar is "as close to or identical to the UI/UX design of the new mockups".
Without automation that is a matter of opinion, and it drifts one ticket at a time. This
harness makes it a number.

```bash
# The whole thing: eighteen routes, light and dark, plus the self-test and the theme swap.
yarn test:e2e:visual

# One route.
yarn test:e2e:visual -g published

# One theme.
yarn test:e2e:visual --project=light
```

It needs the app running (`PLAYWRIGHT_BASE_URL`, default `http://localhost:3000`); the config
starts one if there is none. The report lands in `visual-parity-report/<theme>/index.html`.

## What it compares, and why not pixels

The two sides never show the same data — the mockups say "Payments API v2.4.0" because a
designer typed it, the app says whatever the fixture holds — so a pixel diff of the two is a
diff of two paragraphs of text, not of two designs.

What *is* comparable is that both sides are built on the same tokens: `docs/mockups/assets/hive.css`
and `src/app/globals.css` declare the same ladder, which is what HIVE-1.1 ported. So each side
is reduced to a **token-space signature** and the two are scored along eight dimensions:

| Dimension | Weight | The question it answers |
| --- | ---: | --- |
| Token ladder | 15 % | do the two ladders resolve to the same values at all? |
| Page chrome | 15 % | does the page have the same landmarks, set in the same type? |
| Chrome geometry | 15 % | does that chrome sit in the same place across the page's width? |
| Type scale | 15 % | is the text set on the same steps of the ladder? |
| Spacing rhythm | 20 % | are gaps and paddings drawn from the same vocabulary? |
| Ink palette | 10 % | is the ink drawn from the same tokens? |
| Control heights | 5 % | are buttons and inputs the same height? |
| Surface radii | 5 % | are cards rounded on the same radius? |

The gate is **95 %**. The weights sum to 1 and none is below 5 %, so a page cannot fail a whole
dimension and still pass. `e2e/visual/score.ts` is where each rule is written down and
`tests/visual-parity-score.test.ts` is where each is pinned.

Screenshots are still taken — the mockup, the app, and the two blended with
`mix-blend-mode: difference` so black means agreement. They are published beside the score for
the eye, and attached to the Playwright report, but they are **not** the gate.

## Where the app side comes from

Driving the real route would need a session, a tenant, and a database seeded to match what a
designer typed. Instead the harness mounts the **fixture dumps** every Hive page epic since
HIVE-7.1 already commits: its jsdom suite renders the real components and writes what it
rendered into `e2e/fixtures/hive-<page>/`, and its browser suite mounts that. So what is scored
is exactly what the components compose, and the jsdom suite is what keeps the dump honest.

The fixture is mounted into `/login` — the one route that compiles the real `globals.css`
without needing a session — inside a container of exactly the mockup's page width. That last
part matters: the mockup's page sits beside a rail the fixture does not have, and comparing a
1200 px page against a 1440 px one would report a layout difference that is really a
measurement mistake.

**The mockups are read-only.** They are loaded over `file://`, exactly as
`docs/mockups/README.md` describes its own QA sweep. Nothing here writes to `docs/mockups/`.

## The three suites

| File | What it holds the line on |
| --- | --- |
| `parity.spec.ts` | the gate — one test per route map entry, in light and dark |
| `self-test.spec.ts` | that the gate can fail: 20 px of extra padding on a passing page must fall through it, and must cost at least five points |
| `theme-swap.spec.ts` | that a theme is a token swap — every page's chrome lands on the same pixel in dark as in light |

## Coverage is a ledger

`routes.ts` holds two lists: the eighteen mockups that **are** compared, and every other page
mockup with the reason it is not — its redesign has not landed, it is a dialog rather than a
page, it uses the auth or launcher shell, or its suite builds markup inline instead of
dumping a fixture. `tests/visual-parity-routes.test.ts` fails if a mockup appears in neither,
so a newly drawn screen cannot quietly slip past the harness.

When a redesign ticket lands, move its mockup from `UNCOVERED_MOCKUPS` into `PARITY_ROUTES`
and point it at the fixture that ticket dumped. That is the whole extension procedure.

## Reading a failure

The assertion message is the report:

```
catalog: 91.5 % against sources/catalog.html (gate 95.0 %)
  Token ladder       100.0 %  (weight 15.0 %)
  Page chrome        100.0 %  (weight 15.0 %)
  Chrome geometry    100.0 %  (weight 15.0 %)
  Type scale          70.0 %  (weight 15.0 %)
      · 23.8 % of the weight is off the token scale (the mockup's own rate is 0.5 %)
  Spacing rhythm      85.5 %  (weight 20.0 %)
      · padding: values the mockup never uses: 40 px (1.0 %)
  …
```

Lines marked *reported, not scored* are there for the reader and cost nothing: which token
carries the most characters, and how far two histograms overlap, both follow from how much
content each side happens to show rather than from a design decision.
