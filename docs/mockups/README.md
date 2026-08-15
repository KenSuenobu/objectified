# Apiome “Hive” redesign — mockups

Static, browser-openable mockups for the modern look & feel of `apiome-ui`.
Open **`docs/mockups/index.html`** (double-click, or `npx serve docs/mockups`) —
it is the top-level navigation page; every screen is one click away.

* **`DESIGN.md`** — the design language (principles, tokens, themes & the
  Preferences pane, shell, navigation IA, components, patterns, a11y,
  implementation mapping). Roadmap tickets should cite it by section.
* **`assets/hive.css`** — the design system as CSS custom properties + component
  classes (all nine themes, density, font-scale).
* **`assets/hive.js`** — renders the shared shell (rail / admin rail / studio),
  the ⌘K palette, user & workspace menus, What’s new, and the **Preferences pane**
  (theme grid · font-size slider · density · reduce motion · rail default). These
  preferences are *live* on every mockup and persist in `localStorage`.
* One HTML file per screen, grouped by job: `home/ build/ sources/ ship/ govern/
  workspace/ account/ auth/ studio/ tools/ admin/ foundations/`.

## How to read a mockup

Every page has a small bar bottom-right:

| Control | What it does |
| --- | --- |
| **Index** | back to `index.html` |
| **Notes** | opens the page’s *implementation notes*: the route it replaces, which components it supersedes, what is kept 1:1, what is added, and the empty/loading/error/gated states with copy |
| **Callouts** | toggles numbered annotations where a page has them |
| ☼ / ⚙ | quick light/dark toggle · Preferences pane (`⌘,`) |

Shortcuts: `⌘K` palette · `⌘,` preferences · `⌘\` collapse rail · `Esc` close.

## Page contract (for adding/editing mockups)

```html
<body data-shell="app|admin|studio|auth|bare" data-nav="<rail item id>" data-page="<folder/file>" data-tenant="Acme Corp">
  <main class="page"> …page header + body… </main>
  …overlays (.overlay > .dialog/.drawer/.menu) opened via data-action="open" data-target="<id>"…
  <template id="notes"> …implementation notes… </template>
</body>
```
Rail item ids and the nav model live in `assets/hive.js → navModel()`; the
production equivalent is `lib/platform-nav.ts`.

## Using the mockups from a prompt

A roadmap ticket can be phrased as:

> Implement `docs/mockups/build/projects.html` for `/ade/dashboard/projects`
> following `docs/mockups/DESIGN.md` (§5 shell, §7 components, §8 patterns).
> Keep every behaviour listed under **Notes → Keeps (1:1)**; add the items under
> **Adds**; use the states under **States**. Tokens come from `assets/hive.css`.

The nine roadmap phases (P0 foundations → P8 polish), each with its mockups
and what it ships, are in `DESIGN.md §12`.

## Page → route index

| Mockup | Route today | Shell |
| --- | --- | --- |
| `foundations/design-system.html` · `shell.html` · `settings-pane.html` · `help.html` | — (foundations) | app |
| `auth/login.html` · `two-factor.html` · `signup-oauth.html` · `onboarding.html` | `/login` · `/login/2fa` · `/signup/oauth` · onboarding guard | auth |
| `home/launcher.html` · `home/overview.html` | `/ade` · `/ade/dashboard` | bare · app |
| `account/profile.html` · `linked-accounts.html` | `/ade/dashboard/profile` · `/linked-accounts` | app |
| `workspace/tenants.html` · `members.html` · `roles.html` · `api-keys.html` · `audit.html` | `/ade/dashboard/{tenants,members,roles,api-keys,audit}` | app |
| `govern/style-guides.html` · `style-guide-detail.html` · `lint-posture.html` | `/ade/dashboard/style-guides[/id]` · `/lint-workspace` | app |
| `build/projects.html` · `versions.html` · `version-dialogs.html` · `import-wizard.html` · `primitives.html` · `primitive-detail.html` | `/ade/dashboard/projects` · `/versions` · (dialogs) · ImportDialog · `/primitives[/id]` | app |
| `ship/published.html` · `sunset-timeline.html` · `export-studio.html` | `/ade/dashboard/published` · `/versions/sunset-timeline` · `/export/studio` | app |
| `sources/catalog.html` · `catalog-item.html` | `/ade/dashboard/catalog[/id]` | app |
| `sources/repositories.html` · `repository-new.html` · `repository-detail.html` · `repository-catalog.html` · `repository-telemetry.html` · `webhook-allowlist.html` | `/ade/dashboard/repositories/**` | app |
| `sources/mcp-servers.html` · `mcp-endpoint.html` · `mcp-analytics.html` · `mcp-capabilities.html` · `mcp-compare.html` | `/ade/dashboard/mcp/**` | app |
| `studio/home.html` · `editor.html` · `paths.html` · `code.html` | `/ade/studio/**` | studio |
| `tools/database.html` · `migration.html` | `/ade/database` · `/ade/migration` | app |
| `admin/login.html` · `overview.html` · `users.html` · `tenants.html` · `licenses.html` · `feature-flags.html` · `templates.html` · `settings.html` | `/admin/**` | admin |

## Extending the design system

`assets/hive.css` is the single source of component classes. When a page needs
something new:

1. Check whether an existing class composes into it (most do — `.card` +
   `.table` + `.badge[data-status]` covers the majority).
2. If not, write it page-local in a `<style>` block using **tokens only**
   (never raw hex, never fixed `px` font sizes), then propose it for promotion.
3. Promoted classes live in the numbered sections of `hive.css`; add the new
   component to `foundations/design-system.html` in the same pass so the gallery
   stays complete.

Layout invariant: pages must never scroll horizontally. `.page` and
`.workspace` set `overflow-x: clip`; wide content (tables, diagrams, code)
scrolls inside its own `.table-wrap` / `.scroll-x` container.

## QA

`node scripts/sweep.mjs`-style checks used while authoring (Playwright, from the
repo's own `node_modules`): every page is loaded from `file://`, then checked for
console/page errors, horizontal document overflow, unreplaced `<i data-lucide>`
icons, broken relative links, and a non-empty notes template. Screenshot each
page in light and dark before calling it done.
