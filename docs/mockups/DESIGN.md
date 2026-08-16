# Apiome “Hive” — design language for the apiome-ui redesign

> **Status:** proposal (mockups). This document is the single reference for the
> look, feel and interaction model of the redesigned `apiome-ui`. Every mockup
> under `docs/mockups/` is built on it (`assets/hive.css`, `assets/hive.js`).
> Roadmap tickets should cite sections of this file (e.g. “implement §5.2 rail”)
> and link the relevant mockup HTML.

---

## 0. TL;DR

* **Why:** the current UI reads as an enterprise console — a 280 px gradient
  sidebar with six ALL-CAPS sections, a second 48 px platform bar, indigo/slate
  everywhere, tables of raw ids, and dialogs for everything. It works, but
  nobody *wants* to open it.
* **What changes:** one calm shell (a single collapsible rail, no second top bar),
  warm “paper” surfaces with brand navy ink and one azure accent, a jobs-to-be-done
  navigation, a ⌘K palette, right-side drawers instead of page hops, humane empty
  states, and a **Preferences pane** where users pick a theme, font size and density.
* **What doesn’t change:** routes, data model, permissions, and every feature that
  exists today. Each mockup re-implements the current functionality of its route
  (see §13 page index) — it may add small conveniences, it never removes anything.

---

## 1. Principles

1. **Calm by default, alive on touch.** Neutral surfaces; color is spent on
   meaning (status, focus, the one primary action). Motion is short (120–260 ms),
   eased-out, and only explains cause → effect.
2. **One obvious next step per screen.** Every page has exactly one primary
   button. Everything else is secondary, ghost, or in an overflow menu.
3. **Content-first density.** Comfortable by default, *Compact* in Preferences.
   Rows breathe (46 px / 38 px), controls are 36 px / 32 px, type is 14 px body.
4. **Keyboard-first, mouse-friendly.** ⌘K everywhere; `?` opens the shortcut sheet;
   `G` then a letter jumps; lists are arrow-navigable; every dialog traps focus.
5. **Warm, human, honest.** Empty states teach; errors say what happened and what
   to do next; copy is short, sentence-case, plain English. Hive personality
   (hexagons, honey highlights) appears in brand moments — never in the data.
6. **Progressive disclosure.** Glanceable detail opens in a right drawer with an
   “Open full page ↗” link; real work gets a full page. Wizards are stepped and
   resumable.

---

## 2. Brand & tone

The mark is a bee on a honeycomb (navy `#16265C`, azure `#1E90E8`, honey
`#F5B301`). The design language borrows three things from it:

| Element | Use |
| --- | --- |
| **Navy ink** | primary buttons (light theme), page titles, selected text |
| **Azure accent** | links, focus rings, selected states, info, charts |
| **Honey** | brand ornament only: logo mark, “new”/“starred”/“preview” markers, first-run checklist, empty-state art, the theme grid highlight. Never used to mean *warning* (warnings are amber with an icon). |
| **Hexagon** | workspace avatars (`.avatar--hex`), empty-state art, the faint canvas pattern on auth/launcher pages (`.hex-bg`). |

Voice: confident, brief, kind. “Nothing published yet — publish a version to see it
here.” not “No records found.”

---

## 3. Foundations

### 3.1 Color tokens (light theme defaults)

All values live in `assets/hive.css :root`. Production maps them to Tailwind v4
`@theme` variables (see §11).

| Token | Value | Role |
| --- | --- | --- |
| `--bg-canvas` | `#F6F5F2` | page background (warm paper) |
| `--bg-rail` | `#EFEEEA` | navigation rail |
| `--bg-surface` | `#FFFFFF` | cards, tables, dialogs, inputs |
| `--bg-subtle` | `#F3F2EE` | hovers, secondary fills |
| `--bg-inset` | `#E9E8E3` | wells, code, tracks |
| `--fg` / `--fg-muted` / `--fg-subtle` / `--fg-faint` | `#1B1A17` / `#625F59` / `#8F8B84` / `#B8B4AC` | text hierarchy |
| `--border` / `--border-strong` | `rgba(28,25,20,.09)` / `.18` | hairlines |
| `--ink` / `--ink-fg` | `#16265C` / `#FFF` | primary button (flips to light-on-dark in dark themes) |
| `--accent` / `--accent-soft` / `--accent-fg` | `#1E7FD6` / `#E7F1FC` / `#12539A` | links, focus, selection, info |
| `--honey` / `--honey-soft` / `--honey-fg` | `#F5B301` / `#FFF3C4` / `#6B4E00` | brand ornament |
| `--ok` `--warn` `--danger` (+ `-soft`, `-fg`) | `#0E8A5F` `#C77700` `#D6403A` | semantic |
| `--violet` `--orange` `--rose` `--neutral` (+ `-soft`, `-fg`) | | extended status vocab |

**Status vocabulary → color** (used by `.badge[data-status]`, must match the app’s
enum strings):

| Vocabulary | Values → tone |
| --- | --- |
| Version lifecycle | `draft` neutral · `review` warn · `published` ok · `deprecated` orange · `sunset` danger · `archived` outline |
| Visibility | `private` violet · `public` ok |
| Health / jobs | `healthy`/`ok`/`completed` ok · `degraded`/`running`/`pending` warn · `down`/`failed`/`error` danger · `unknown` neutral |
| Lint severity | `error` danger · `warning` warn · `info`/`hint` accent |
| Keys / members | `active` ok · `revoked` danger · `disabled` outline · `suspended` warn |
| Maturity | `preview`/`beta` accent · `new` honey |
| Format pills | `.fmt--openapi/asyncapi/graphql/proto/jsonschema/wsdl/x12/copybook/avro/raml/wit/postman/mcp` (fixed hues so a format is recognisable across screens) |
| HTTP methods | `.method--get/post/put/patch/delete` (fixed hues) |

### 3.2 Typography

* **UI:** Inter (already self-hosted via `next/font`), features `cv11 ss01 ss03`
  for the single-storey *a* and open digits. **Code/ids:** JetBrains Mono.
* Scale (rem, so the font-size preference scales everything):
  `2xs 11 · xs 12 · sm 13 · md 14 (body) · lg 15 · xl 17 · 2xl 20 · 3xl 24 (page title) · 4xl 30 (stat) · 5xl 38 (display)`.
* Titles use `letter-spacing: -0.02em`, weight 600. Section labels are 11 px
  600 uppercase `+0.06em` `--fg-subtle`. Numbers in tables/stats use
  `font-variant-numeric: tabular-nums`.
* Never more than three weights on a screen (400 / 500 / 600).

### 3.3 Spacing, radii, elevation

* 4 px grid. Page padding 32 px (24 compact). Card padding 20 px (16). Gap
  between page sections 24 px.
* Radii: `xs 4 · sm 6 · md 10 (controls) · lg 14 (cards) · xl 20 (dialogs) · full`.
* Elevation is *tint + hairline + soft shadow*, never heavy drop shadows:
  `--shadow-sm` for cards/tables, `--shadow-md` on hover, `--shadow-lg` for
  popovers/dialogs, `--shadow-raised` for the active nav item and segmented thumb.
* Borders are translucent (`rgba(28,25,20,.09)`) so they work on every surface.

### 3.4 Motion

* Durations: `fast 120` (hover, toggles) · `base 180` (menus, tabs) · `slow 260`
  (dialogs, drawers, rail collapse). Easing `cubic-bezier(.2,.8,.2,1)`.
* Dialogs rise 8 px + fade; drawers slide from the right; palette rises from 12 vh.
* Respect `prefers-reduced-motion` and the “Reduce motion” preference
  (`html[data-motion="reduce"]`).

### 3.5 Iconography

Lucide, 16 px in dense UI, 18 px in the rail, 15 px in buttons, stroke 1.75.
Icons are always paired with text except in icon-buttons that carry a tooltip.

---

## 4. Themes & Preferences (the settings pane)

**Mockup:** `foundations/settings-pane.html` (the pane itself is live on every
mockup: gear in the rail footer, user menu → Preferences, or `⌘,`).

### 4.1 Pane anatomy
Right drawer (520 px) with tabs **Appearance · Account · Notifications · Shortcuts**.
Appearance contains, in order:

1. **Theme** — 3-column grid of theme cards (preview swatch, name, one-line
   description), radio semantics, applies immediately. The nine existing themes
   map 1:1: `system, light, dark, high-contrast, blueprint, whiteboard, solarized,
   nord, darcula`. Each is a token swap on `html[data-theme]`; layout/typography
   never change between themes.
2. **Font size** — 6-stop slider (`xs 14 · sm 15 · md 16 · lg 17 · xl 18 · 2xl 20 px`
   root size) with a live preview card. Implemented as
   `html[data-font-scale]{font-size:%}`; because every dimension is `rem`, the
   *whole* interface scales, not just body text.
3. **Density** — segmented **Comfortable / Compact** (`html[data-density]`), swaps
   the spacing tokens in §3.3.
4. Switches — **Reduce motion** (`html[data-motion]`), **Collapse sidebar by
   default** (`html[data-rail]`), **Monospace for identifiers**
   (`html[data-mono-ids]`, swaps the face of `.mono` — ids, hashes, versions —
   never of a code block), **Show keyboard hints** (`html[data-kbd-hints]`, hides
   the `.kbd` chips; the shortcuts themselves keep working).

Footer: “Saved automatically”. Persistence keys (localStorage, per device):
`hive.theme`, `hive.fontScale`, `hive.density`, `hive.rail`, `hive.motion`,
`hive.monoIds`, `hive.kbdHints`. The
production build should keep the existing `app-theme` / `theme` keys as aliases
during migration so users don’t lose their theme.

### 4.2 Theme behaviour
* “Follow system” listens to `prefers-color-scheme` and re-resolves live.
* Dark-based themes flip `--ink` to light so the primary button stays highest
  contrast (`dark, high-contrast, blueprint, solarized, nord, darcula`).
* Format pills / method chips keep fixed hues in every theme (identity > tint).

---

## 5. Layout & shell

### 5.1 One shell, three moods
| Shell | Used by | Anatomy |
| --- | --- | --- |
| **App** (`data-shell="app"`) | every `/ade/dashboard/**` page, tools | rail + page |
| **Admin** (`data-shell="admin"`) | `/admin/**` | rose-tinted rail with “Admin console” label, its own nav, “Back to app” |
| **Auth** | `/login`, `/login/2fa`, `/signup/oauth`, `/admin` login | split brand panel + form card on hex canvas |

The old 48 px platform bar (Home / Control Panel / Designer / Developer tabs +
tenant pill + version badge + theme + profile) is **retired**. Its jobs move to:

| Old header element | New home |
| --- | --- |
| Home / Control Panel tabs | rail brand → *All apps* launcher; rail *Home* item |
| Designer / Developer suite menu | commercial suite entries injected into the rail and launcher by the host at runtime — those products live in their own repositories and are not designed here |
| Tenant switcher | **Workspace switcher** at the top of the rail (hex avatar + name + role · plan) |
| Version badge / What’s new | user menu → *What’s new* (honey dot when unread) + build string in menu footer |
| Theme selector | Preferences pane (and quick light/dark toggle in the mock bar) |
| Profile menu | rail footer user button → Profile · Linked accounts · Preferences · What’s new · Shortcuts · Admin console · All apps · Sign out |

### 5.2 Rail (`.rail`)
264 px expanded / 64 px collapsed (`⌘\`, chevron on hover, or Preferences).
Top-to-bottom: brand (mark + “apiome / Platform”), workspace switcher, search
trigger (`⌘K`), grouped nav, footer (Help & docs · Preferences · user).
Nav item: 34 px, icon 18 px + 13 px label; hover = 5 % ink tint; **active = white
raised pill** (`--shadow-raised`) with an azure icon. Group labels are 11 px caps.
Gated items (no current tenant) render at 45 % with a tooltip. Collapsed rail shows
tooltips on hover and hairlines between groups.

### 5.3 Page header (`.page-header`)
Sticky, translucent (backdrop blur), 1 px hairline. Contains breadcrumb (12 px),
title (24 px/600/-0.02em, optional badge), one-line description, right-aligned
actions (**one** primary + secondaries + overflow), optional underline tab row.
Content max-width 1440 px; reading/forms pages use `.page-body--narrow` (920 px).

### 5.4 Overlays
* **Dialog** — 560 px default (`sm 440 · lg 760 · xl 960 · full`), 20 px radius,
  header/body/footer, footer tinted; destructive confirms use a red primary and
  name the object (“Delete *Payments API*?”). Replace every `window.confirm`.
* **Drawer** — right, 520/680/860 px, for detail/quick-edit (audit event, member,
  key, catalog item preview, lint finding). Has “Open full page ↗” when a page exists.
* **Menu** — 200–300 px, 32 px items with icons and optional shortcut chip.
* **Command palette** — 640 px, groups *Jump to · Actions · Recent*, typeahead,
  `>` for commands.
* **Toast** — bottom-right, 360 px, icon + title + description + optional action
  (used for Undo on bulk lint decisions).


---

## 6. Navigation IA (jobs to be done)

Routes are unchanged; only grouping and labels change.

| Group | Item | Route today |
| --- | --- | --- |
| — | **Home** | `/ade/dashboard` |
| **Build** | Projects (→ Versions) | `/ade/dashboard/projects`, `/ade/dashboard/versions` |
| | Primitives & types | `/ade/dashboard/primitives`, `/[id]` |
| **Bring in** | Catalog | `/ade/dashboard/catalog`, `/[id]` |
| | Repositories | `/ade/dashboard/repositories/**` |
| | MCP servers | `/ade/dashboard/mcp/**` |
| **Ship** | Published | `/ade/dashboard/published` |
| | Sunset timeline | `/ade/dashboard/versions/sunset-timeline` |
| | Export studio | `/ade/dashboard/export/studio` |
| **Govern** | Style guides | `/ade/dashboard/style-guides`, `/[guideId]` |
| | Lint posture *(Preview)* | `/ade/dashboard/lint-workspace` |
| | Access audit | `/ade/dashboard/audit` |
| **Workspace** | Members · Roles · API keys · Tenants | `/ade/dashboard/{members,roles,api-keys,tenants}` |
| **Tools** | Data browser · Migrations | `/ade/database`, `/ade/migration` |
| user menu | Profile · Linked accounts | `/ade/dashboard/profile`, `/linked-accounts` |
| brand / user menu | All apps (launcher) | `/ade` |
| user menu | Admin console | `/admin/**` |

Commercial (private-suite) items are injected into *Build* / *Bring in* / *Ship*
by the host through the same nav model (`hive.js → navModel()` is the mockup
stand-in for `lib/platform-nav.ts`).

---

## 7. Component library (class → purpose → production mapping)

| Class (hive.css) | Purpose | Production |
| --- | --- | --- |
| `.btn` `--primary --accent --ghost --soft --danger --danger-soft --link --sm --lg --icon --pill` | buttons; primary = ink | `components/ui/Button` variants |
| `.input .select .textarea .input-wrap .field .hint .error` | forms; 36 px controls, inset hairline, azure focus | `Input`, `Select`, `Textarea`, `FormField` |
| `.check .radio .switch .switch-row .slider .segmented` | choice controls | `Checkbox`, `RadioGroup`, `Switch`, new `Segmented` |
| `.tabs .tab .count` `--pills` `.vtabs` | underline tabs with counts | `Tabs` + `tabStyles` |
| `.badge[data-status] .badge--*` `.fmt--*` `.method--*` `.chip` `.tag` `.dot` | status vocab, format & method pills, filter chips | `Badge`, `ui/catalog/FormatPill`, `ui/mcp/*Pill` |
| `.card .card__header/body/footer` `--hover --flat --soft --honey --link --selected` | panels | `Card` |
| `.stat` `.stat-grid` `.ring` `.sparkline` `.bars` `.meter` `.progress` | metrics | new `Stat`, `Ring`, `Sparkline` |
| `.table-wrap .table-toolbar .table .table-foot .pager .bulk-bar` | data tables: sticky caps header, hover, selection, dense variant, sticky bulk bar | new `DataTable` (replaces `dashboardScreenClasses.ts`) |
| `.empty` `--inline --dashed` | empty states with hex art, title, desc, CTA | `EmptyState` |
| `.skeleton .spinner` | loading | `Skeleton`, `Spinner` |
| `.dialog .drawer .menu .palette .toast .banner .callout .tooltip` | overlays | `Dialog`, new `Drawer`, `DropdownMenu`, `cmdk`, `sonner`, `Alert` |
| `.avatar` `--hex --brand --a..e` `.avatar-stack` | people & workspaces | new `Avatar` |
| `.stepper .step` `.timeline .tl-item` `.tree .tree__item` `.split .panel` | wizards, history, split panels | new |
| `.code` `--dark --lines` `.diff-add .diff-del` | code & diff | `ui/code/*` |
| `.icon-tile` `--accent --honey --ok --warn --danger --violet --hex` | leading icons | new |
| `.kbd` | shortcut chips | new |
| `.hex-bg .glow-honey .brand-mark` | brand ornament | new |

---

## 8. Patterns

* **List page** = page header (title, description, primary “New …”) → optional
  stat strip → `.table-wrap` with toolbar (search, filter chips, view segmented,
  sort) → table with hover row actions → foot (count · pager). Selection reveals
  a sticky `.bulk-bar`. Empty table → `.empty` inside the card. Filters live in
  the URL (as the lint workspace already does).
* **Detail page** = breadcrumb + title + status badge + actions → underline tabs
  → two-column body (main + 340 px aside with metadata `.kv`).
* **Drawer-first details** for audit events, members, keys, catalog previews,
  lint findings, MCP endpoint quick view.
* **Wizard** = dialog `--lg/--xl` with `.stepper` in the header, one primary
  “Continue”, ghost “Back”, secondary “Save & close”; long-running steps show
  `.progress--striped` + a live log; async jobs continue in a toast when closed.
* **Destructive** = red primary, object named, consequence sentence, optional
  type-to-confirm for tenants/projects.
* **Keyboard** = `⌘K` palette · `⌘,` preferences · `⌘\` rail · `?` shortcuts ·
  `G P/C/L…` jumps · `N` new · `I` import · `/` focus search · `Esc` close.
* **Loading** = skeletons shaped like the final content (never spinners in
  tables) · **Error** = inline banner with retry.
* **Copy** = sentence case; buttons are verbs (“Create key”, not “OK”); numbers
  are tabular; relative times with absolute tooltip.

---

## 9. Accessibility

WCAG 2.2 AA minimum, AAA in *High contrast*. Focus ring 3 px azure at 28 %.
44 px min touch targets in comfortable density (rows/buttons meet it). All icons
have text or `aria-label`; all overlays trap focus and restore it; tables have
`scope`d headers; live regions for save state and async jobs. Themes are tested
for 4.5:1 body / 3:1 large text.

---

## 10. Content & voice

Titles are nouns (“Projects”), buttons are verbs (“New project”), descriptions
answer “what is this for?” in ≤ 14 words. Avoid “Manage”, “Configure” as titles.
Errors: what happened + what to do (“Slug is taken — try `acme-eu`”).

---

## 11. Implementation mapping & migration strategy

1. **Tokens** — add `@theme` in `globals.css` mirroring `hive.css :root`
   (`--color-canvas`, `--color-surface`, `--color-ink`, `--color-accent`… plus
   `--radius-*`, `--shadow-*`); keep old vars as aliases for one release.
   Radix `Theme`: `accentColor="blue"`, `grayColor="sand"`, `radius="large"`,
   `panelBackground="solid"`; scaling driven by the font-size preference.
2. **Themes** — `ThemeProvider` sets `data-theme` (resolved) + `data-theme-choice`
   on `<html>`; keep the nine ids; the token swaps in `hive.css §4` become the
   per-theme blocks in `globals.css` (replacing the ad-hoc `.theme-*` rules).
3. **Font size / density** — new `PreferencesProvider` (localStorage keys in §4.1)
   sets `data-font-scale`, `data-density`, `data-motion`, `data-rail`; audit `px`
   font-sizes/heights in components → `rem`/tokens.
4. **Shell** — new `AppShell` (rail + page) replaces `DashboardSideNav` +
   `TopHeader` on `/ade/dashboard/**`; `ConditionalHeader` goes away;
   `/admin` uses `AppShell` with `variant="admin"`.
   Nav model lives in `lib/platform-nav.ts` (groups + gating + commercial injection).
5. **Preferences pane** — `PreferencesDrawer` (Radix Dialog as side sheet) with
   theme grid, slider, segmented, switches; replaces `ThemeSelector`.
6. **Components** — extend `components/ui` with `Segmented`, `Drawer`, `Avatar`,
   `Stat`, `DataTable`, `EmptyState` (hex art), `Kbd`, `Stepper`, `Timeline`;
   restyle existing primitives to tokens; replace all `window.confirm/prompt`
   with `ConfirmDialog`/form dialogs.
7. **Pages** — migrate route by route in the roadmap order (§12), each ticket
   linking its mockup and this document.

---

## 12. Roadmap phases

Each phase is a self-contained slice: it lands tokens/components *and* the
screens that prove them, so `main` is never half-restyled. A ticket cites its
mockup file plus the sections of this document it implements, and inherits the
mockup’s **Notes → Keeps (1:1) / Adds / States** as its acceptance criteria.

| Phase | Theme | Mockups | Ships |
| --- | --- | --- | --- |
| **P0** | Foundations | `foundations/design-system.html`, `foundations/settings-pane.html` | `@theme` tokens in `globals.css`, the nine theme blocks, `PreferencesProvider` + `PreferencesDrawer` (theme · font size · density · motion · rail), Radix re-config, `rem` audit. No page moves yet. |
| **P1** | Shell | `foundations/shell.html`, `home/overview.html`, `home/launcher.html` | `AppShell` (rail + page header) replacing `DashboardSideNav` + `TopHeader`, nav model in `lib/platform-nav.ts`, workspace switcher, user menu, ⌘K palette, shortcut sheet, Home + launcher. |
| **P2** | Primitives + list pattern | `build/projects.html`, `build/versions.html`, `build/version-dialogs.html`, `build/import-wizard.html` | `DataTable`, `Segmented`, `Drawer`, `Stat`, `Avatar`, `EmptyState`, `Kbd`, `Stepper`; Projects + Versions + all version dialogs + the import wizard. Retires `dashboardScreenClasses.ts`. |
| **P3** | Bring in | `sources/catalog*.html`, `sources/repository*.html`, `sources/webhook-allowlist.html`, `sources/mcp-*.html` | Catalog list & item (inspectors), Repositories (all 7 routes), MCP catalog/endpoint/analytics/capabilities/compare. |
| **P4** | Ship + Govern | `ship/*.html`, `govern/*.html` | Published, sunset timeline, Export studio; style guides + detail, lint posture. |
| **P5** | Workspace + account | `workspace/*.html`, `account/*.html`, `auth/*.html` | Tenants (drawer-based admin), members, roles, API keys, audit; profile, linked accounts; login, 2FA, OAuth sign-up, onboarding. Replaces every `window.confirm`/`prompt`. |
| **P6** | Admin + tools | `admin/*.html`, `tools/*.html` | Admin console on the same shell (rose variant), users/tenants/licenses/flags/templates/auth providers; data browser, migrations. Removes the three dead nav links. |
| **P7** | Polish | all | Empty-state art pass, motion + reduced-motion, a11y sweep (focus, live regions, AAA in High contrast), density audit, copy pass. |

Ordering rule: **P0 → P1 first and in order** (everything else depends on tokens
and the shell). P2 must precede P3–P5, which are otherwise independent of each
other. P6 can run in parallel with P3–P5 once P2 lands.

## 13. Page index

See `README.md` for the full mockup → route → components table. Every mockup
also carries a **Notes** panel (bottom-right mock bar → *Notes*) with the route,
what it replaces, and per-screen implementation notes.
