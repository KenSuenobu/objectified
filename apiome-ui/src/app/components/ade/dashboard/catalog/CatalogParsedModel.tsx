'use client';

/**
 * CatalogParsedModel (MFI-25.3 #4088; parsed-model explorer MFI-28.3 #4119).
 *
 * Presentational rendering of the catalog detail's normalized `parsed` model (MFI-25.2, #4087) — a
 * paradigm-tagged entity list projected from the item's canonical model. The Overview pane renders
 * these blocks under the aggregate count boxes so a catalog item shows its *actual* parsed entities
 * (operations / types / services / messages / channels with their fields), not just the counts.
 *
 * MFI-28.3 turns each group into a scannable explorer rather than a wall of expanded entities:
 *   - every entity is a **lazy-mounting disclosure** — its field rows mount only on first expand
 *     (small entities in small groups default open), so a 200-entity model renders fast and collapsed;
 *   - each group carries a live **filter box** that narrows its entities by name or tag;
 *   - each entity keeps its **stable anchor id** (`catalogEntityAnchorId`) so a lint finding can
 *     deep-link straight to it (MFI-28.2) — a deep-linked entity is force-expanded and never hidden
 *     by an active filter;
 *   - a per-group **raw-model toggle** renders the group's normalized JSON in the shared read-only
 *     Monaco viewer (`JsonViewer` from `ui/code`, promoted out of `ui/mcp` by MFI-28.7).
 *
 * The `parsed` shape is intentionally presentation-agnostic (no colors, ordering hints, or markup);
 * all styling lives here: `parsedTagToneClass` maps each entity tag to a Tailwind tone, and
 * `deriveParsedSummaryNote` folds the groups into the mockup's `summaryNote` sub-line
 * (e.g. "8 queries · 4 mutations · 2 subscriptions"). Source: mockup `entHTML`/`openDetail`
 * (`docs/planning/mockups/multi-format-import/index.html:1415-1453`).
 */

import { useMemo, useState } from 'react';
import { Box, Braces, ChevronRight, Filter, X } from 'lucide-react';
import { cn } from '@lib/utils';
import { dashboardPanelClass } from '@/app/components/ade/dashboard/dashboardScreenClasses';
import { catalogEntityAnchorId } from '@/app/utils/catalog-lint-panel';
import { JsonViewer } from '@/app/components/ui/code';
import { STATUS_TONE_SOFT_CLASS } from '@/app/components/ui/statusVocabulary';

/** One field row on a parsed entity (mockup `.frow`): name / rendered type / description. */
export interface CatalogParsedField {
  name: string;
  /** Compact, presentation-agnostic `TypeRef` rendering (nullability lives on `required`). */
  type: string;
  description?: string | null;
  /** Outer non-nullability — the renderer decides how to mark it (here: a rose `*`). */
  required?: boolean | null;
}

/** A parsed entity (operation / type / service / message / channel …) with a paradigm tag. */
export interface CatalogParsedEntity {
  name: string;
  /** Paradigm-specific kind used for the colored tag (e.g. QUERY, OBJECT, SERVICE, CHANNEL). */
  tag: string;
  /** Short human hint shown after the name (e.g. `→ [Order]`, `6 fields`). */
  meta?: string | null;
  fields: CatalogParsedField[];
}

/** A group of parsed entities (mockup `entHTML` card): a titled, optionally-subtitled block. */
export interface CatalogParsedGroup {
  title: string;
  subtitle?: string | null;
  entities: CatalogParsedEntity[];
}

/**
 * The colour of an entity tag, keyed by tag (HIVE-7.1, #5318).
 *
 * Twenty-four hand-written `bg-emerald-100 text-emerald-700 dark:…` pairs used to live here,
 * which is a palette standing in for a taxonomy: two tags with the same hue by accident read
 * as related, and none of them followed a theme. Every entry is now one of two things, and
 * which one is the interesting part:
 *
 *  - a **status tone** (`ui/statusVocabulary`) where the tag describes what an operation or a
 *    type *does* — a read, a write, a stream, a name for something else;
 *  - a **fixed verb hue** (`.method--*`, HIVE-2.4) for the five HTTP methods, because a
 *    method's colour is an identity rather than a state.
 *
 * Every value is a full literal, never concatenated, so Tailwind keeps them. The geometry —
 * radius, padding, size — belongs to the caller.
 */
const PARSED_TAG_TONE: Record<string, string> = {
  // GraphQL operations / gRPC + AsyncAPI verbs — what the operation *does*, which is a
  // state-shaped distinction, so it takes a status tone: reads accent, writes warn, streams
  // violet.
  QUERY: STATUS_TONE_SOFT_CLASS.accent,
  MUTATION: STATUS_TONE_SOFT_CLASS.warn,
  SUBSCRIPTION: STATUS_TONE_SOFT_CLASS.violet,
  SEND: STATUS_TONE_SOFT_CLASS.warn,
  RECEIVE: STATUS_TONE_SOFT_CLASS.ok,
  // HTTP verbs (REST / data-schema fallback). These take the *fixed* verb hues instead —
  // DESIGN.md §2 and HIVE-2.4: a method's colour is an identity, not a state, so GET is the
  // same blue here as on every operation row in the product. `.method--*` sets fill and ink
  // only; the geometry comes from the caller, as it does for every other entry in this table.
  GET: 'method--get',
  POST: 'method--post',
  PUT: 'method--put',
  PATCH: 'method--patch',
  DELETE: 'method--delete',
  OPERATION: STATUS_TONE_SOFT_CLASS.accent,
  // GraphQL / gRPC / generic type kinds
  OBJECT: STATUS_TONE_SOFT_CLASS.ok,
  INPUT: STATUS_TONE_SOFT_CLASS.accent,
  INTERFACE: STATUS_TONE_SOFT_CLASS.accent,
  UNION: STATUS_TONE_SOFT_CLASS.violet,
  ENUM: STATUS_TONE_SOFT_CLASS.neutral,
  SCALAR: STATUS_TONE_SOFT_CLASS.neutral,
  ALIAS: STATUS_TONE_SOFT_CLASS.neutral,
  MAP: STATUS_TONE_SOFT_CLASS.ok,
  // gRPC / AsyncAPI structural kinds
  SERVICE: STATUS_TONE_SOFT_CLASS.ok,
  MESSAGE: STATUS_TONE_SOFT_CLASS.ok,
  CHANNEL: STATUS_TONE_SOFT_CLASS.violet,
};

const PARSED_TAG_TONE_FALLBACK = STATUS_TONE_SOFT_CLASS.neutral;

/**
 * The soft tone classes for an entity tag (case-insensitive; neutral for anything unmapped).
 *
 * The tags come from the shared status vocabulary (HIVE-2.4) since HIVE-7.1 (#5318): this
 * table used to carry twelve hand-written `bg-emerald-100 … dark:` pairs, which is a palette
 * standing in for a taxonomy. What survived the collapse is the distinction the reader
 * actually uses — *a thing you can call* (ok), *a thing you pass in* (accent), *a choice
 * between shapes* (violet), *a name for something else* (neutral).
 */
export function parsedTagToneClass(tag: string | null | undefined): string {
  if (!tag) return PARSED_TAG_TONE_FALLBACK;
  return PARSED_TAG_TONE[tag.trim().toUpperCase()] ?? PARSED_TAG_TONE_FALLBACK;
}

/** Lowercase + naive English pluralization of a tag for the summary note (n===1 stays singular). */
function pluralizeTag(tag: string, n: number): string {
  const lower = tag.toLowerCase();
  if (n === 1) return lower;
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(lower)) return `${lower}es`;
  return `${lower}s`;
}

/**
 * Fold the parsed groups into the mockup's `summaryNote` sub-line by tallying entities per tag in
 * first-seen order (e.g. "8 queries · 4 mutations · 2 subscriptions"). Returns `null` when there is
 * no parsed model, so the caller renders nothing rather than an empty line.
 */
export function deriveParsedSummaryNote(
  parsed: CatalogParsedGroup[] | null | undefined,
): string | null {
  if (!parsed || parsed.length === 0) return null;
  const segments: string[] = [];
  for (const group of parsed) {
    const order: string[] = [];
    const counts = new Map<string, number>();
    for (const entity of group.entities) {
      const tag = (entity.tag ?? '').trim();
      if (!tag) continue;
      if (!counts.has(tag)) order.push(tag);
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    for (const tag of order) {
      const n = counts.get(tag) ?? 0;
      segments.push(`${n} ${pluralizeTag(tag, n)}`);
    }
  }
  return segments.length > 0 ? segments.join(' · ') : null;
}

// --- Explorer helpers (MFI-28.3) ------------------------------------------------------------
// Pure, unit-testable pieces the disclosure/filter/raw-JSON UI is built from, so the default-open
// heuristic, the live filter, and the normalized-JSON serialization can be pinned without a DOM.

/** An entity with this many fields (or fewer) may default open — its field rows are cheap to mount. */
export const PARSED_SMALL_ENTITY_MAX_FIELDS = 4;
/** Above this entity count a group is "large": every entity defaults collapsed so it renders fast. */
export const PARSED_LARGE_GROUP_ENTITY_COUNT = 20;

/**
 * Whether an entity's disclosure should default open. A field-less entity never opens (there is
 * nothing to mount); in a large group everything stays collapsed so a 200-entity model renders fast;
 * otherwise a *small* entity opens for convenience while big ones stay collapsed until asked for.
 *
 * @param fieldCount        The entity's field count.
 * @param groupEntityCount  The number of entities in the entity's group.
 * @returns True when the entity should render expanded on first paint.
 */
export function parsedEntityDefaultOpen(fieldCount: number, groupEntityCount: number): boolean {
  if (fieldCount <= 0) return false;
  if (groupEntityCount > PARSED_LARGE_GROUP_ENTITY_COUNT) return false;
  return fieldCount <= PARSED_SMALL_ENTITY_MAX_FIELDS;
}

/** Whether an entity matches a filter query (case-insensitive substring on name or tag). */
export function parsedEntityMatchesFilter(entity: CatalogParsedEntity, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    entity.name.toLowerCase().includes(q) || (entity.tag ?? '').toLowerCase().includes(q)
  );
}

/** Narrow a group's entities to those matching the filter query (all of them when it is blank). */
export function filterParsedEntities(
  entities: CatalogParsedEntity[],
  query: string,
): CatalogParsedEntity[] {
  if (!query.trim()) return entities;
  return entities.filter((entity) => parsedEntityMatchesFilter(entity, query));
}

/**
 * Serialize a group to its normalized-model JSON for the raw-model viewer: the group's `title`,
 * `subtitle`, and its entities (each with tag/meta/fields), pretty-printed. This is the same shape
 * the read carries (MFI-25.2), so the raw view is the model verbatim rather than a re-projection.
 */
export function parsedGroupToJson(group: CatalogParsedGroup): string {
  return JSON.stringify(
    { title: group.title, subtitle: group.subtitle ?? null, entities: group.entities },
    null,
    2,
  );
}

/** A single field row (mockup `.frow`): name / type (+ required marker) / description. */
function ParsedFieldRow({ field }: { field: CatalogParsedField }) {
  return (
    <div
      data-testid="catalog-detail-parsed-field"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs sm:flex-nowrap"
    >
      <span className="truncate font-mono text-gray-700 dark:text-gray-300 sm:w-40 sm:shrink-0" title={field.name}>
        {field.name}
      </span>
      <span
        className="truncate font-mono text-indigo-600 dark:text-indigo-400 sm:w-48 sm:shrink-0"
        title={field.type}
      >
        {field.type}
        {field.required ? (
          <span className="text-rose-500" title="required">
            {' *'}
          </span>
        ) : null}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400"
        title={field.description ?? undefined}
      >
        {field.description ?? ''}
      </span>
    </div>
  );
}

/** The colored tag chip + monospace name + optional meta hint shared by both entity header shapes. */
function ParsedEntityHeading({ entity }: { entity: CatalogParsedEntity }) {
  return (
    <>
      <span
        data-testid="catalog-detail-parsed-tag"
        className={cn(
          'inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-2xs font-bold uppercase tracking-wider',
          parsedTagToneClass(entity.tag),
        )}
      >
        {entity.tag}
      </span>
      <span className="truncate font-mono text-sm font-semibold text-gray-900 dark:text-white">
        {entity.name}
      </span>
      {entity.meta ? (
        <span className="truncate text-xs text-gray-400 dark:text-gray-500">{entity.meta}</span>
      ) : null}
    </>
  );
}

/**
 * A single parsed entity rendered as a lazy-mounting disclosure. The header (tag + name + meta) is
 * always present so the entity is scannable and addressable by its anchor even while collapsed; the
 * field rows mount only after the first expand (and stay mounted, hidden, afterwards) so a large
 * model never pays every entity's field cost up front. A field-less entity has no toggle. A
 * deep-linked (`highlighted`) entity is force-expanded so its fields are visible when scrolled to.
 */
function ParsedEntityDisclosure({
  entity,
  anchorId,
  highlighted,
  defaultOpen,
}: {
  entity: CatalogParsedEntity;
  /** Stable DOM id so a lint finding can deep-link to this entity (MFI-28.2). */
  anchorId: string;
  /** True while this entity is the target of a just-followed lint deep-link (transient ring). */
  highlighted: boolean;
  /** Whether the disclosure starts expanded (small entities in small groups do). */
  defaultOpen: boolean;
}) {
  const hasFields = entity.fields.length > 0;
  const [open, setOpen] = useState(defaultOpen && hasFields);
  // Track whether the body has ever been shown so field rows mount lazily (like ui/code Disclosure).
  const [everOpened, setEverOpened] = useState(defaultOpen && hasFields);

  // A deep-link to this entity forces it open (derived, no effect) so its fields are visible when
  // scrolled into view; once the transient highlight clears it falls back to the user's own toggle.
  const forcedOpen = highlighted && hasFields;
  const effectiveOpen = open || forcedOpen;
  // Field rows mount lazily: on first expand, or immediately when a deep-link forces this entity open.
  const mountFields = hasFields && (everOpened || forcedOpen);

  return (
    <div
      id={anchorId}
      data-testid="catalog-detail-parsed-entity"
      className={cn(
        // `scroll-mt-24` keeps the entity clear of the sticky header when scrolled into view.
        'scroll-mt-24 overflow-hidden rounded-lg border transition-colors',
        highlighted
          ? 'border-indigo-400 bg-indigo-50 ring-2 ring-indigo-400 dark:border-indigo-500 dark:bg-indigo-900/20 dark:ring-indigo-500'
          : 'border-gray-200 bg-white hover:border-indigo-200 dark:border-gray-700 dark:bg-gray-800 dark:hover:border-indigo-800',
      )}
    >
      {hasFields ? (
        <button
          type="button"
          data-testid="catalog-detail-parsed-entity-toggle"
          aria-expanded={effectiveOpen}
          onClick={() => {
            setOpen((prev) => !prev);
            setEverOpened(true);
          }}
          className="flex w-full items-center gap-2 p-3 text-left"
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform',
              effectiveOpen && 'rotate-90',
            )}
            aria-hidden
          />
          <ParsedEntityHeading entity={entity} />
          <span className="ml-auto shrink-0 whitespace-nowrap font-mono text-2xs tabular-nums text-gray-400 dark:text-gray-500">
            {entity.fields.length} {entity.fields.length === 1 ? 'field' : 'fields'}
          </span>
        </button>
      ) : (
        <div className="flex items-center gap-2 p-3">
          <ParsedEntityHeading entity={entity} />
        </div>
      )}
      {mountFields ? (
        <div
          className={
            effectiveOpen
              ? 'space-y-1 border-t border-gray-100 px-3 pb-3 pt-2 dark:border-gray-700'
              : 'hidden'
          }
        >
          {entity.fields.map((field, i) => (
            <ParsedFieldRow key={`${field.name}-${i}`} field={field} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One group card (mockup `entHTML`): a titled block with a live name/tag filter, a raw-model toggle,
 * and its entities rendered as lazy disclosures. The filter and raw-view are per-group local state;
 * a deep-linked entity is always shown (the filter never hides it) so cross-tab lint links land.
 */
function ParsedGroupCard({
  group,
  highlightedAnchor,
}: {
  group: CatalogParsedGroup;
  highlightedAnchor: string | null;
}) {
  const [query, setQuery] = useState('');
  const [rawOpen, setRawOpen] = useState(false);
  const total = group.entities.length;

  // The entities to render: filter matches, plus the deep-linked entity even when the filter would
  // hide it, so a lint finding always resolves to a visible, highlightable anchor.
  const visible = useMemo(() => {
    const matched = filterParsedEntities(group.entities, query);
    if (!highlightedAnchor) return matched;
    const alreadyShown = matched.some(
      (entity) => catalogEntityAnchorId(entity.name) === highlightedAnchor,
    );
    if (alreadyShown) return matched;
    const pinned = group.entities.find(
      (entity) => catalogEntityAnchorId(entity.name) === highlightedAnchor,
    );
    return pinned ? [...matched, pinned] : matched;
  }, [group.entities, query, highlightedAnchor]);

  const filtering = query.trim() !== '';

  return (
    <section data-testid="catalog-detail-parsed-group" className={`${dashboardPanelClass} p-6`}>
      <div className="flex items-center gap-2">
        <Box className="h-4 w-4 shrink-0 text-indigo-500" aria-hidden />
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {group.title}
        </h2>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-2xs font-semibold tabular-nums text-gray-500 dark:bg-gray-700/60 dark:text-gray-300">
          {total}
        </span>
        {group.subtitle ? (
          <span className="ml-auto min-w-0 truncate text-xs text-gray-400 dark:text-gray-500">
            {group.subtitle}
          </span>
        ) : null}
      </div>

      {total > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* Live filter (name/tag). Disabled while the raw model is shown — it has no entity rows. */}
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Filter
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400"
              aria-hidden
            />
            <input
              type="text"
              data-testid="catalog-detail-parsed-filter"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={rawOpen}
              placeholder="Filter by name or tag…"
              aria-label={`Filter ${group.title} by name or tag`}
              className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-8 text-xs text-gray-700 placeholder:text-gray-400 focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
            />
            {filtering ? (
              <button
                type="button"
                data-testid="catalog-detail-parsed-filter-clear"
                onClick={() => setQuery('')}
                aria-label="Clear filter"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 transition-colors hover:text-gray-700 dark:hover:text-gray-200"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
          {filtering && !rawOpen ? (
            <span
              data-testid="catalog-detail-parsed-filter-count"
              className="shrink-0 font-mono text-2xs tabular-nums text-gray-400 dark:text-gray-500"
            >
              {visible.length} of {total}
            </span>
          ) : null}
          <button
            type="button"
            data-testid="catalog-detail-parsed-raw-toggle"
            aria-pressed={rawOpen}
            onClick={() => setRawOpen((prev) => !prev)}
            className={cn(
              'ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
              rawOpen
                ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-300'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700',
            )}
          >
            <Braces className="h-3.5 w-3.5" aria-hidden />
            {rawOpen ? 'Hide raw model' : 'Raw model'}
          </button>
        </div>
      ) : null}

      {rawOpen ? (
        <div data-testid="catalog-detail-parsed-raw" className="mt-3">
          <JsonViewer
            value={parsedGroupToJson(group)}
            label={`${group.title} — normalized model`}
            maxLines={32}
          />
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {visible.length > 0 ? (
            visible.map((entity, ei) => {
              const anchorId = catalogEntityAnchorId(entity.name);
              return (
                <ParsedEntityDisclosure
                  key={`${entity.name}-${ei}`}
                  entity={entity}
                  anchorId={anchorId}
                  highlighted={highlightedAnchor === anchorId}
                  defaultOpen={parsedEntityDefaultOpen(entity.fields.length, total)}
                />
              );
            })
          ) : (
            <p
              data-testid="catalog-detail-parsed-no-matches"
              className="rounded-lg border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400 dark:border-gray-700 dark:text-gray-500"
            >
              No entities match “{query.trim()}”.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Render the parsed entity groups as a stack of explorer cards (one per group). When there is no
 * parsed model (URL-only source, unknown format, or nothing captured) a graceful "no parsed model"
 * note stands in — a read never errors on a missing model (MFI-25.2), so the Overview degrades
 * rather than breaking.
 */
export function CatalogParsedGroups({
  parsed,
  highlightedAnchor = null,
}: {
  parsed: CatalogParsedGroup[] | null | undefined;
  /** Anchor id of the entity a just-followed lint deep-link is highlighting, if any (MFI-28.2). */
  highlightedAnchor?: string | null;
}) {
  if (!parsed || parsed.length === 0) {
    return (
      <section
        data-testid="catalog-detail-parsed-empty"
        className={`${dashboardPanelClass} p-6`}
      >
        <p className="text-sm text-gray-500 dark:text-gray-400">
          No parsed model is available for this item — the normalized entities could not be
          reconstructed from the captured source.
        </p>
      </section>
    );
  }

  return (
    <>
      {parsed.map((group, gi) => (
        <ParsedGroupCard
          key={`${group.title}-${gi}`}
          group={group}
          highlightedAnchor={highlightedAnchor}
        />
      ))}
    </>
  );
}
