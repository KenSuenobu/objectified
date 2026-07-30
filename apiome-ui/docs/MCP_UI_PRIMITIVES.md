# MCP UI primitives (V2-MCP-24.7 / MCAT-10.7)

The shared, **token-driven** component library every MCP catalog screen reuses — the grade glyph,
the tone-based badge, health & recency pills, the finding-severity chip, the detail tab shell, and
the empty / loading / error states. These primitives exist **before** the screens that consume them
(10.1 nav + import source, 10.2 Overview + Capabilities, 10.4 Lint & Score, 10.8 Catalog grid) so
those screens never re-implement the visual atoms or scatter color/spacing literals — which is what
keeps a central dark theme (10.10) addable in one place.

> **Live gallery:** run the app and open [`/design-system/mcp`](../src/app/design-system/mcp/page.tsx)
> to see every primitive in every variant (the Storybook-equivalent for this codebase).

## Where things live

| Layer | Path | What |
| --- | --- | --- |
| Pure helpers (React-free, unit-tested) | `src/app/components/ade/dashboard/mcp/mcpUiPrimitives.ts` | Grade styles, badge-tone resolvers, health/recency, tab definitions |
| React components | `src/app/components/ui/mcp/` | `GradeGlyph`, `McpBadge`, `HealthPill`, `RecencyPill`, `ServerProfileCard`, `CapabilityGraphPanel`, `ToolComplexityPanel`, `SafetyPosturePanel`, `DocCoveragePanel`, `CapabilityChurnPanel`, `CapabilityPresenceMatrixPanel`, `GradeSurfaceTrendPanel`, `ChangedSinceDigestPanel`, `DiscoveryHealthPanel`, `ToolLatencyPanel`, `ScoreBreakdownPanel`, `TrustProfilePanel`, `FindingSeverity`, `DetailTabs` |
| Shared states | `src/app/components/ui/{EmptyState,LoadingState,ErrorState}.tsx` | empty / loading / error placeholders |
| Barrel | `@/app/components/ui/mcp` (also re-exported from `@/app/components/ui`) | one import for all MCP primitives |

**Design principle:** consumers pass *domain values* (a transport string, a discovery status, an ISO
timestamp) and the primitive picks the color, never the other way round. Colors are Tailwind utility
classes — the project's token layer, mapped centrally (with `dark:` variants) in `globals.css`. No
hex or spacing literal ever appears in a consumer.

## Components

### `<GradeGlyph>`

The A–F + 0–100 grade signal — the lead glyph on cards, headers, and the lint gauge.

```tsx
<GradeGlyph grade="B" score={82} />                    {/* solid chip: B · 82 */}
<GradeGlyph score={94} />                               {/* letter derived from score → A */}
<GradeGlyph variant="gauge" size="lg" grade="A" score={91} /> {/* 0–100 ring */}
<GradeGlyph />                                          {/* unscored → neutral chip */}
```

| Prop | Type | Notes |
| --- | --- | --- |
| `grade` | `string \| null` | A–F; derived from `score` when omitted |
| `score` | `number \| null` | 0–100; shown unless `showScore={false}` |
| `variant` | `'glyph' \| 'gauge'` | square chip (default) or ring |
| `size` | `'sm' \| 'md' \| 'lg'` | |

### `<McpBadge tone=…>`

The seven-tone badge (`indigo`, `green`, `amber`, `red`, `blue`, `slate`, `violet`) backing the
transport / visibility / auth / capability-annotation chips. Resolve a domain value with the helpers,
then render:

```tsx
const t = mcpTransportBadge(endpoint.transport);   // { tone, label }
<McpBadge tone={t.tone}>{t.label}</McpBadge>

const a = mcpAnnotationHints(item)                 // existing helper
  .map((h) => mcpCapabilityAnnotationBadge(h.key, h.value))
  .filter(Boolean);                                // only asserted hints
```

Resolvers (in `mcpUiPrimitives.ts`): `mcpTransportBadge`, `mcpVisibilityBadge`, `mcpAuthBadge`,
`mcpCapabilityAnnotationBadge`.

### `<HealthPill>`

Endpoint reachability as a colored dot + label: `healthy` (green), `degraded` (amber),
`unreachable` (red), `unknown` (slate). Pass an explicit `status`, or a raw `discoveryStatus` to
have it resolved via `mcpHealthFromDiscoveryStatus`.

```tsx
<HealthPill status="healthy" />
<HealthPill discoveryStatus="unchanged" /> {/* → Healthy (successful auto-refresh) */}
<HealthPill discoveryStatus="changed" />   {/* → Healthy (surface updated) */}
<HealthPill discoveryStatus="failed" />    {/* → Unreachable */}
<HealthPill status="degraded" dotOnly />   {/* dot only, label kept for screen readers */}
```

### `<RecencyPill>`

The "Last discovered …" chip: a clock icon + a short relative span (`just now` / `5m ago` /
`2h ago` / `3d ago`), falling back to an absolute date past ~30 days. Formatting is delegated to the
unit-tested `mcpRelativeTime(iso, nowMs)` helper.

```tsx
<RecencyPill timestamp={endpoint.last_discovered_at} />
<RecencyPill timestamp={ts} prefix="Discovered" hideIcon />
```

### `<ServerProfileCard>` (V2-MCP-29.1 / MCAT-15.1)

The at-a-glance "who is this server" identity card that heads the endpoint **Insight** tab. It
composes the primitives above (grade glyph, transport badge, health & recency pills) into one
header: the server's name/title/version, negotiated `protocol_version`, transport, quality grade,
capability counts, discovery health, the "surface changed" recency, a compact trust snapshot that
links to the composite trust radar (17.4), and the server's `instructions` when present.

It is purely presentational — it reads a pre-assembled `McpServerProfile`, built (React-free,
unit-tested) by `mcpServerProfileFrom({ endpoint, version, surface, instructions })` from the sources
the Insight tab already holds. Every field degrades to `null`, so an older (2025-03-26) server
missing a title/protocol, an unscored snapshot, or an unavailable surface all render a coherent card.

```tsx
const profile = mcpServerProfileFrom({ endpoint, version: selectedVersion, surface, instructions });
<ServerProfileCard profile={profile} trustHref="#insight-reliability" />
```

### `<ToolComplexityPanel>` (V2-MCP-29.3 / MCAT-15.3)

The tool schema **"shape" & complexity** cards on the endpoint **Insight** tab. Each card profiles one
tool's `input_schema` from the 14.1 metrics — parameter count with a required-vs-optional split
mini-bar, max nesting depth, `enum` / `oneOf` presence, and whether an `output_schema` is declared —
tagged with a coarse complexity **tier** (None → Very high). Above the cards it draws a tier
**distribution histogram** (via `BarSeries`) and a **sort** (most/least complex, name, params, depth)
and **filter** (has/no params, nested, enum, oneOf, output-schema) toolbar. A no-parameter tool and a
huge nested/polymorphic schema both render sanely.

It is purely presentational — it reads the `tool_complexity[]` the surface fetch already returns; all
scoring, tier bucketing, sorting, filtering, and binning live in the React-free, unit-tested
`mcpToolComplexityUi` module (a tier carries a *tone token*, never a color literal). It owns only the
sort/filter selection state, and handles its own loading / error / no-tools / filtered-to-empty states.

```tsx
<ToolComplexityPanel
  tools={surface ? surface.metrics.tool_complexity : null}
  loading={surfaceLoading}
  error={surfaceError}
/>
```

### `<SafetyPosturePanel>` (V2-MCP-29.4 / MCAT-15.4)

The **safety & annotation posture** panel on the endpoint **Insight** tab. It hoists the single most
important safety signal — read-only vs destructive — out of each tool's per-item `annotations` into a
per-tool **matrix** of the four behavioural hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`). Each matrix cell is a **tri-state** (asserted / declared-false / not-declared), so an
explicit `false` reads differently from an omitted hint. Above the matrix it shows a **posture
headline** ("3 destructive, 1 open-world, 8 read-only") and the endpoint's **auth badge**, and it
cross-references the two: on an **anonymous** endpoint (`auth_type: none`) the destructive tools are
flagged as **reachable with no auth**. A surface whose tools declare no hints at all renders an explicit
**"unannotated — treat with caution"** state, since absence of a hint is not a guarantee of safety.

It is purely presentational — it reads the snapshot's capability `items` (for per-tool annotations) and
the endpoint's `auth_type`, both threaded from the Insight tab's fetches. All counting, tri-state
resolution, auth-posture derivation, and the destructive-without-auth cross-reference live in the
React-free, unit-tested `mcpSafetyPostureUi` module, reusing `mcpAnnotationHints` (hint extraction) and
`mcpAuthBadge` (auth tone/label). It handles its own loading / error / no-tools states.

```tsx
<SafetyPosturePanel
  items={items}
  authType={authType}
  loading={itemsLoading}
  error={itemsError}
/>
```

### `<DocCoveragePanel>` (V2-MCP-29.5 / MCAT-15.5)

The **documentation & schema coverage** meters on the endpoint **Insight** tab — a four-gauge row that
makes a server's otherwise-invisible documentation quality legible: **% of items described**, **% of
items titled**, **% of tool parameters documented**, and **output-schema adoption** across tools. Each
gauge is a **drill-down**: expanding it lists the *specific* under-documented items behind the
percentage (the params gauge names each tool with its `N of M undocumented` tally), so a coverage number
is one click from the items that fall short. A meter with nothing to measure — a tool-less server has no
parameters or output schemas — renders an explicit **N/A** rather than a misleading red `0%`, keeping a
`0%` reading meaning "measured, none covered".

It is purely presentational — it reads the snapshot's capability `items` (the same fetch the safety
panel uses), so a gauge's percentage and its drill-down are computed from one source and can never
disagree. All counting, the offender lists, and the not-applicable resolution live in the React-free,
unit-tested `mcpDocCoverageUi` module; the gauge itself is the shared `<Gauge>` chart primitive
(`0–100` auto-colors by score band). It handles its own loading / error / no-capability states.

```tsx
<DocCoveragePanel items={items} loading={itemsLoading} error={itemsError} />
```

### `<CapabilityChurnPanel>` (V2-MCP-30.1 / MCAT-16.1)

The **capability churn timeline** on the endpoint **Insight** tab — a stacked column per discovery
snapshot (oldest→newest) split into the **added / removed / modified** counts it introduced, so *how
much* a server churns and *when* is legible at a glance instead of buried in a version list. A
**zero-churn version still gets its slot** on the axis (an empty column), the **busiest release** is
called out, and **clicking any column deep-links to that version's diff** in the Versions tab (the
detail page routes `onSelectVersion` → the compare/diff viewer, selecting the version against its
predecessor).

It reads the endpoint's per-version series from `insight/evolution`; all series-shaping and the
per-column deep-link ids come from the React-free, unit-tested `mcpEvolutionUi` module (`mcpChurnTimeline`),
so the chart and its click targets can never disagree. The chart itself is the interactive
`<StackedTimeline>` primitive (`onSelectPeriod`). It owns its loading / error / no-history states.

```tsx
<CapabilityChurnPanel series={evolution} loading={loading} error={error} onSelectVersion={openDiff} />
```

### `<CapabilityPresenceMatrixPanel>` (V2-MCP-30.2 / MCAT-16.2)

The **capability lifespan / presence matrix** on the endpoint **Insight** tab — a *"gantt of the
surface"*: rows are every distinct capability ever seen, columns are discovery snapshots
(oldest→newest), and each cell is **added / present / modified / absent**. It answers "is this tool
stable, or was it added last week and might vanish?": each row carries a **lifespan badge** (stable /
new / volatile / removed) and the headline summarizes how many capabilities are current, new,
volatile, or removed. **Clicking a version-column header deep-links to that snapshot's diff** (same
`onSelectVersion` → compare/diff route as the churn panel). The matrix **scrolls** (sticky header +
sticky first column) so it scales to many capabilities and many versions.

There is no server-side matrix endpoint: presence is reconstructed on the client from the same
per-version `McpVersionDetail` snapshots the browse/insight views already load. All reconstruction and
the added-vs-modified classification live in the React-free, unit-tested `mcpPresenceMatrixUi` module
(`mcpPresenceMatrix`). Classification is **adjacency-based** — each cell is compared only to the
immediately preceding snapshot, exactly as the server's diff engine does — so the matrix stays
consistent with `mcp_version_changes`: a **rename** reads as its old name going *absent* (removed) and
its new name *added*, because the diff engine records a rename the same way. It owns its loading /
error / empty states.

```tsx
<CapabilityPresenceMatrixPanel versions={versionDetails} loading={loading} error={error} onSelectVersion={openDiff} />
```

### `<GradeSurfaceTrendPanel>` (V2-MCP-30.4 / MCAT-16.4)

The **grade & surface-size trend** on the endpoint **Insight** tab — answers *"is this server getting
better or worse over time?"* with two `<TrendLine>` charts across discovery snapshots (oldest→newest):
the **quality score** (0–100 / A–F) and the **capability count**. An **unscored snapshot is gapped, not
zeroed** — the score line breaks across it (a hollow tick) rather than crashing to zero. The snapshots
that introduced a **breaking change** (`severity_counts.breaking > 0`, from MCAT-16.3) are overlaid as
**vertical markers aligned to the version that broke**, and listed as chips that **deep-link to that
version's diff** (same `onSelectVersion` → compare/diff route as the churn panel). The headline leads
with the latest grade glyph and the current capability count; each chart shows its delta since the
start of history.

It reads the same per-version `insight/evolution` series as the churn panel; all series-shaping, the
marker indices, and the deltas come from the React-free, unit-tested `mcpEvolutionUi` module
(`mcpGradeSurfaceTrend`), so the charts, markers, and summary can never disagree. It owns its loading /
error / no-history states.

```tsx
<GradeSurfaceTrendPanel series={evolution} loading={loading} error={error} onSelectVersion={openDiff} />
```

### `<ChangedSinceDigestPanel>` (V2-MCP-30.5 / MCAT-16.5)

The **"changed since last view" digest** at the top of the endpoint **Insight** tab — a *per-user*
welcome-back summary of what changed on the server's surface since the viewer last looked. It diffs the
version they last saw (a server-side seen-marker, `mcp_endpoint_views`) against the current version and
classifies the delta by breaking severity (MCAT-16.3). Three states, from the pure `mcpDigestState`
projection: **new to you** (first visit / pruned marker — shows the current surface size), **changed** (a
breaking-change callout when any are breaking, per-severity and per-direction tallies, the changed items
capped with a "+N more" note, and a `Review changes` button that deep-links to the current version's
diff), and **up to date** (a calm acknowledgement). It owns its loading / error states.

The panel is presentational: the Insight tab fetches the digest (`/insight/digest`) and, *after* reading
it, advances the marker (`POST /views`) so the digest always reflects the pre-advance "since your last
visit" delta and the next visit reads relative to now. All payload-shaping lives in the React-free,
unit-tested `mcpDigestUi` module (`mcpDigestFromPayload`, `mcpDigestState`).

```tsx
<ChangedSinceDigestPanel digest={digest} loading={loading} error={error} onReviewChanges={openDiff} />
```

### `<DiscoveryHealthPanel>` (V2-MCP-31.1 / MCAT-17.1)

The **discovery health & availability timeline** in the endpoint **Insight** tab's *Reliability & trust*
section — "has this server been reachable over time?". From the `health` block of `insight/reliability`
it renders an **availability %** over the recent discovery window (ok / (ok + failed) terminal jobs), a
`StackedTimeline` **status strip** of each recent discovery job's outcome (ok / unreachable / auth_error /
…, one uniform-height column per job coloured by outcome), a **per-code failure breakdown**, and a
prominent **quarantine banner** when the endpoint has tripped the consecutive-failure threshold and been
auto-excluded from the discovery sweep (V133). It owns its loading / error / empty states — a
never-discovered endpoint shows a "no history yet" empty state.

The panel is presentational: the Insight tab fetches `/insight/reliability` once (endpoint-level). All
payload-shaping and tallies live in the React-free, unit-tested `mcpReliabilityUi` module
(`mcpReliabilityHealthFromPayload`, `mcpDiscoveryHealthTimeline`, `mcpDiscoveryOutcomeLabel`,
`mcpAvailabilityKind`), so the strip, the counts, and the availability figure can never disagree.

```tsx
<DiscoveryHealthPanel health={health} loading={loading} error={error} />
```

### `<ToolLatencyPanel>` (V2-MCP-31.2 / MCAT-17.2)

The **tool latency & error-rate panel** in the endpoint **Insight** tab's *Reliability & trust* section —
"how fast and how reliable is each tool?". From the `tools` block of `insight/reliability` (the test
console records a `latency_ms` / `is_error` per call, aggregated per tool over a recent window) it renders
an **error-rate headline** and call/tool totals, a `BarSeries` **latency distribution** of every tool
call, and a **slowest** (by p95) and **flakiest** (by error rate) tool ranking — each row showing that
tool's p50/p95/p99 latency and error rate. It owns its loading / error / empty states — a never-tested
endpoint shows a "no tool calls yet" empty state, and a single-call tool renders its one sample as all
three percentiles without dividing by zero.

The panel is presentational: the Insight tab parses it from the *same* `/insight/reliability` fetch as the
discovery health panel. All payload-shaping, ranking, and formatting live in the React-free, unit-tested
`mcpReliabilityUi` module (`mcpToolReliabilityFromPayload`, `mcpSlowestTools`, `mcpFlakiestTools`,
`mcpErrorRateKind`, `mcpFormatMs`, `mcpFormatErrorRate`), so the rows can never disagree with the totals.

```tsx
<ToolLatencyPanel reliability={tools} loading={loading} error={error} />
```

### `<ScoreBreakdownPanel>` (V2-MCP-31.3 / MCAT-17.3)

The **score & lint breakdown panel** in the endpoint **Insight** tab's *Reliability & trust* section —
"where did this server's quality grade come from?". The Lint & Score tab (MCAT-10.4) shows the single
grade; this decomposes it. From the version's `mcp_version_scores.report` (fetched through the same
per-version lint route the Lint tab uses) it renders a **score reconstruction** headline (the grade
gauge plus the point total the findings deducted, replayed from the scorer's model so the breakdown
agrees with the grade), **points lost by rule group** (a severity-tinted bar per rule category —
naming / structure / annotations / security / hygiene — showing which groups cost the most, with a `*`
when a chatty rule's cost was capped), a `BarSeries` **findings-by-severity** distribution, and a
drill-down list of the findings grouped by severity, each linking to the offending capability item. It
owns its loading / error / empty states — an unscored snapshot shows an "unavailable" state and a clean
report (no findings) shows a "clean bill of health" state; a legacy report whose stored grade predates
the current scorer still renders (the stored grade leads).

The panel is presentational: the Insight tab fetches the selected snapshot's lint report and re-fetches
on selector change. All arithmetic lives in the React-free, unit-tested `mcpLintUi` module
(`mcpLintScoreBreakdown`, `mcpLintTierCounts`, `mcpLintGroupByTier`, `mcpLintFindingTarget`), so the
bars, the tallies, and the reconstructed score can never disagree with the findings the list shows.

```tsx
<ScoreBreakdownPanel report={report} loading={loading} error={error} onNavigateToItem={navigateToItem} />
```

### `<TrustProfilePanel>` (V2-MCP-31.4 / MCAT-17.4)

The **composite trust profile radar** — the capstone of the endpoint **Insight** tab's *Reliability &
trust* section. It collapses the section's many scattered signals into one five-axis glance so an
evaluator can size up a server at a look. From the endpoint-level `insight/trust` payload it renders a
`Radar` across five normalized 0–100 axes — **quality** (grade), **safety** (annotation coverage +
destructive/auth posture), **documentation** (coverage), **stability** (inverse breaking-change rate),
and **responsiveness** (latency/error) — beside an **overall composite** headline ("N of 5 signals
measured") and a per-axis breakdown, each axis exposing its **methodology on hover**. Every axis whose
input is missing renders as an explicit **gap** (an em dash / "Not measured"), never a zero, so a
never-tested server reads as "not measured" rather than "scored zero"; gaps are excluded from the
overall. It is deliberately a **heuristic composite** — a synthesized glance, not an official rating —
and says so. The panel owns its loading / error / not-enough-signal states.

The panel is presentational: the Insight tab fetches the profile endpoint-level. The five axes are
computed **server-side** (apiome-rest `compute_trust_profile`); the React-free, unit-tested `mcpTrustUi`
module (`mcpTrustProfileFromPayload`, `mcpTrustBand`, `mcpTrustRadarAxes`, `mcpTrustFormatValue`)
parses the payload and re-derives the overall / measured-count from the axes, so the headline, the
radar, and the list can never disagree.

```tsx
<TrustProfilePanel profile={trust} loading={loading} error={error} />
```

### `<CatalogAnalyticsDashboard>` (V2-MCP-32.1 / MCAT-18.1)

The **tenant-wide catalog analytics** screen — the catalog-level counterpart to the per-endpoint
Insight tab, rendered on `/ade/dashboard/mcp/analytics`. From the tenant `insight/catalog` payload it
rolls the whole catalog into: a **headline stat row** (endpoints, published, discovered, scored, avg
score); three `Donut` **mixes** — endpoints by **category**, by **transport**, and by A–F **grade**
(the grade ring toned by band, greens → reds); three `BarSeries` **distributions** — `protocol_version`
adoption, the **tool-count** histogram, and the **discovery-health** rollup; and two **leaderboards** —
the most-churned endpoints (**change-frequency leaders**, each linked to its endpoint detail) and the
most widely exposed capabilities (**top capabilities**, a real "how many endpoints expose each"
aggregate standing in for the roadmap's "most-searched", which has no backing query log — the panel
says so). The panel owns its loading / error / **empty-catalog** first-run states.

The panel is presentational: the page fetches `insight/catalog`. The breakdowns are aggregated
**server-side** (apiome-rest `get_mcp_catalog_insight` + `compute_tool_count_histogram`); the
React-free, unit-tested `mcpCatalogInsightUi` module (`mcpCatalogInsightFromPayload`,
`mcpCatalogIsEmpty`, `mcpCatalogPercent`, `mcpCatalogGradeTone`, `mcpCatalogDonutSegments`,
`mcpCatalogBars`) parses the payload and builds the donut/bar projections, so the tiles, legends, and
percentages can never disagree.

```tsx
<CatalogAnalyticsDashboard data={insight} loading={loading} error={error} />
```

### `<ServerComparisonPanel>` (V2-MCP-32.2 / MCAT-18.2)

The **side-by-side server comparison** screen, rendered on `/ade/dashboard/mcp/compare`. The
evaluator picks 2–3 discovered servers; the page fetches each one's current-version surface (`items`,
protocol, grade), its `insight/trust`, and its `insight/reliability`, and hands one `McpCompareServer`
per column to the panel. From that bundle it renders an **aligned metric table** — **surface counts**,
**quality** (grade/score), **safety posture** (destructive / unannotated / no-auth / auth), **doc
coverage**, **tool latency** (slowest p95 / error rate / calls), and **composite trust** (overall +
per-axis) — with every **differing row highlighted**, a **trust radar** per column, a
**capability-overlap** presence matrix (shared vs unique tools), and a **protocol banner** when the
servers negotiated different MCP protocol versions. Owns its loading / error / too-few-selected states.

The panel is presentational; all logic lives in the React-free, unit-tested `mcpServerCompareUi`
module (`mcpCompareModel`, `mcpToolOverlap`, `mcpCompareProtocolVersions`, `mcpCompareSurfaceCounts`),
which reuses the single-server helpers (`mcpSafetyPosture`, `mcpDocCoverageMeters`, `mcpSlowestTools`,
the trust projections) so a metric reads the same here as on the endpoint's own Insight tab.

```tsx
<ServerComparisonPanel servers={servers} loading={loading} error={error} />
```

### `<PeerPercentilePanel>` (V2-MCP-32.3 / MCAT-18.3)

The **peer percentile & category ranking** panel on the endpoint Insight tab's *Reliability & trust*
section — a *peer baseline*, not an absolute grade. From `insight/percentile` it ranks the server
against the other live servers in its catalog **category** on four axes — **grade**, **safety**,
**documentation**, **latency** — rendering per axis a **"top N%" badge** toned by relative standing
(top 10% → green, top 25% → blue, top 50% → indigo, bottom half → slate), the server's own value, and
its "rank K of N" basis. A **single-member category** is called out explicitly (rather than a
meaningless "top 100%"), and any axis the server has not measured is a labelled **gap**, never a
misleading zero.

The panel is presentational; the projections come from the React-free, unit-tested
`mcpPeerPercentileUi` module (`mcpPeerPercentileFromPayload`, `mcpPeerBand`, `mcpPeerBadgeLabel`,
`mcpPeerCategoryLabel`), and the axis values are computed server-side reusing the same trust-axis
derivations, so a rank never disagrees with the server's own Insight numbers.

```tsx
<PeerPercentilePanel profile={peerPercentile} loading={loading} error={error} />
```

### `<FindingSeverity>`

The shared MUST / SHOULD / Advisory chip used by the Lint & Score tab and inline hints. It renders
through the project `Badge` in the tier's variant, reading label + variant from the single source of
truth in `mcpLintUi` so styling never drifts.

```tsx
<FindingSeverity tier="must" />
<FindingSeverity severity="warning" count={5} />   {/* "SHOULD 5" */}
```

### `<DetailTabs>`

The MCP detail strip. It renders the app-wide underline tab look from
`src/app/components/ui/tabStyles.ts` — the same look the base `Tabs` primitive and every hand-rolled
strip use — and adds the MCP tab-set plumbing on top. Built on Radix tabs, so it stays
keyboard-accessible and controllable. The canonical seven-tab set is `MCP_DETAIL_TABS`
(Overview · Capabilities · Versions · Lint & Score · Test · Credentials · Settings); a screen may
auto-render the full set or any subset.

```tsx
<DetailTabs value={tab} onValueChange={setTab}>
  <DetailTabsList items={MCP_DETAIL_TABS} only={['capabilities', 'lint', 'versions']} />
  <DetailTabsContent value="capabilities">…</DetailTabsContent>
  <DetailTabsContent value="lint">…</DetailTabsContent>
  <DetailTabsContent value="versions">…</DetailTabsContent>
</DetailTabs>
```

### Empty / loading / error states

`<EmptyState>`, `<LoadingState>`, and the new `<ErrorState>` (red-tinted, with an optional
`onRetry`) complete the placeholder trio for any panel that has no data, is loading, or failed.

## Chart kit (V2-MCP-28.3 / MCAT-14.3)

A small, hand-rolled **SVG** primitive set in `src/app/components/ui/mcp/charts/` (re-exported from
`@/app/components/ui/mcp`) so every insight panel gets charts without a heavyweight dependency
(`mermaid` remains the only chart-ish dep; revisit Recharts/visx only if a panel outgrows SVG). Each
chart follows the same principle as the rest of this kit — **consumers pass domain data, the chart
picks the color from Tailwind tokens** — and is:

- **Accessible** — the SVG is `role="img"` with a `<title>`/`<desc>`, and a visually-hidden
  (`sr-only`) `<table>` carries the underlying numbers for screen readers / no-CSS. An **interactive**
  chart (e.g. `<StackedTimeline onSelectPeriod>`) switches the frame to `role="group"` so its
  focusable/clickable marks are reachable, while the label + data table still describe the whole figure.
- **Responsive** — sized by `viewBox`; set height/size with a `className` on the chart.
- **SSR-safe** — no DOM/`window` access; gradient ids come from `React.useId`.
- **Empty-safe** — empty / degenerate data renders a small empty state, never a crash.

| Component | Shape | Typical use |
| --- | --- | --- |
| `<Sparkline data tone domainMax area />` | axis-free trend line + area | grade/latency over time (inline) |
| `<TrendLine data tone domainMax markers area />` | gapped line + area, optional index markers | score/capability count over versions; a `null` gaps the line (not zeroed), markers flag breaking releases |
| `<BarSeries data tone domainMax />` | vertical bars (per-bar `tone` override) | capability counts by type, findings by severity |
| `<Donut segments centerLabel />` | proportional ring | transport / auth-scheme share |
| `<StackedTimeline series periods onSelectPeriod? activeIndex? />` | stacked bars over an ordered axis (columns optionally clickable) | per-version churn (added/removed/modified), deep-linked to the diff |
| `<Radar axes max tone />` | multi-axis profile (≥ 3 axes) | documentation / annotation / safety coverage |
| `<Heatmap matrix rowLabels colLabels tone />` | intensity grid (opacity = magnitude) | activity by day×hour, error rate by tool×version |
| `<Gauge value min max tone centerLabel />` | 270° dial | a bounded score; `0–100` auto-colors by score band |

```tsx
import { Sparkline, Donut, Gauge } from '@/app/components/ui/mcp';

<Sparkline data={[62, 65, 61, 70, 80]} tone="emerald" />
<Donut segments={[{ label: 'http', value: 12 }, { label: 'sse', value: 8 }]} centerLabel="20" />
<Gauge value={94} />                                   {/* 0–100 → colored by score band */}
<Gauge value={420} min={0} max={1000} tone="blue" centerLabel="420ms" />
```

**Color is never a literal.** Series colors resolve through `chartTokens.ts`: a semantic
`ChartSeriesTone` (`indigo`, `emerald`, `amber`, `red`, `blue`, `violet`, `green`, `orange`, `cyan`,
`pink`, `neutral`) → `fill-*` / `stroke-*` / `text-*` utilities with `dark:` variants, plus a stable
categorical order (`chartCategoricalTone`) for series that don't pin a tone. The pure coordinate math
lives in `chartGeometry.ts` (sparkline points, donut/gauge arcs, radar polygons, cell intensity).

## Theming (10.10)

Every color is a Tailwind class with a `dark:` counterpart, resolved centrally. A new theme adds its
variant in `globals.css` / Tailwind config — never by touching a primitive or a consumer. Because no
consumer hard-codes a color, a dark variant lands in one place.

## Tests

- `tests/mcp-ui-primitives.test.ts` — the pure mappings (grade, badge tones, health, recency, tabs).
- `tests/mcp-primitives-components.test.tsx` — render coverage for every component variant.
- `tests/mcp-chart-tokens.test.ts` — chart tone → class mapping (no color literals, cyclic palette).
- `tests/mcp-chart-geometry.test.ts` — the pure chart coordinate math (arcs, points, intensity, gapped trend segments).
- `tests/mcp-charts.test.tsx` — render + snapshot coverage for every chart, incl. empty states.
- `tests/mcp-evolution-ui.test.ts` — the pure evolution helpers (churn timeline + grade/surface-size trend projections).
- `tests/mcp-grade-trend-panel.test.tsx` — the grade & surface-size trend panel (gaps, markers, deep-links).
- `tests/mcp-server-compare-ui.test.ts` — the pure comparison helpers (metric alignment + differs, tool overlap fixture, protocol cross-check).
- `tests/mcp-server-comparison-panel.test.tsx` — the comparison panel (columns, sections, overlap matrix, protocol banner, radar/gap states).
- `tests/mcp-peer-percentile-ui.test.ts` — the pure peer-ranking helpers (parser, standing bands, "top N%" badge labels, gaps).
- `tests/mcp-peer-percentile-panel.test.tsx` — the peer-ranking panel (per-axis badges, cohort context, single-member, gap/empty states).
