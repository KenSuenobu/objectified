/**
 * Target families — the four groups the Export Studio's target grid draws (HIVE-8.3, #5329).
 *
 * Authority: `docs/mockups/ship/export-studio.html`, Step 2, whose target grid carries the
 * headings *REST & HTTP*, *RPC*, *Events* and *Data schema & graph* over what was one flat
 * list of thirty-six cards.
 *
 * ### Why a family rather than a longer list
 *
 * Every registered emitter renders as a card, and there are thirty-six of them. A flat grid
 * asks the reader to scan all of them to answer a question they already know the shape of —
 * "what are my gRPC options?" — because the only ordering it offered was readiness, which
 * interleaves paradigms. Grouping answers that question in one jump and *costs nothing*: the
 * families are derived from `descriptor.paradigm`, a field REST has always sent, so nothing
 * new is fetched and no target can be missing from a group.
 *
 * The ordering **inside** a family is untouched — it is still whatever `orderTargetCards`
 * produced (readiness first by default, registry order on request), so the readiness band a
 * reader sorts by still ranks the cards they are looking at.
 *
 * ### The rule that matters
 *
 * A paradigm this table does not know still gets a group ({@link OTHER_FAMILY}), never a
 * dropped card. That is what kept "all 36 targets reachable" true when the registry grew:
 * `ApiParadigm`'s `agent` member had no emitter behind it, and when the first one landed
 * (the LLM tool-array target, FMT-2.5) it appeared under *Other targets* rather than
 * vanishing from the grid — which is the safety net working, not the finished answer.
 * FMT-2.7 (#5425) gave that paradigm its own heading, so a reader looking for "what can I
 * hand an agent?" finds it under a name instead of under *Other*.
 *
 * Everything here is pure — no React, no fetch — so the partition is unit-tested directly.
 */

/** A group heading in the target grid, and the paradigms that land under it. */
export interface ExportTargetFamily {
  /** Stable key, used for React keys, `data-family` attributes and tests. */
  key: string;
  /** The heading the mockup prints above the group. */
  label: string;
}

/**
 * The families, in the order the grid draws them.
 *
 * The order is the mockup's and it is not alphabetical: it runs from the paradigm most
 * sources are (`rest`) to the one fewest are, so the reader's likeliest answer is the first
 * heading they meet. *Agents & tools* is appended last for the same reason — it is the
 * newest and smallest family, and putting it above *Data schema & graph* would push the
 * larger group down for no gain.
 */
export const EXPORT_TARGET_FAMILIES: readonly ExportTargetFamily[] = [
  { key: 'rest', label: 'REST & HTTP' },
  { key: 'rpc', label: 'RPC' },
  { key: 'event', label: 'Events' },
  { key: 'data', label: 'Data schema & graph' },
  { key: 'agent', label: 'Agents & tools' },
] as const;

/** Where a paradigm with no family of its own lands — a heading, never a hidden card. */
export const OTHER_FAMILY: ExportTargetFamily = { key: 'other', label: 'Other targets' };

/**
 * `descriptor.paradigm` → family key.
 *
 * The keys are the wire values of REST's `ApiParadigm` (`apiome-rest/src/app/canonical_model.py`).
 * `graph` shares the data-schema heading because GraphQL's SDL is, to a reader choosing an
 * export, the same kind of answer as Avro or JSON Schema: a type system rather than a
 * transport. `schema` is accepted as a legacy spelling of `data_schema`.
 *
 * `agent` gets a heading of its own rather than joining `rest`: a tool array is not a
 * transport description at all — it is the list of calls a model may make — so a reader
 * scanning for an HTTP export would have to read past it, and a reader scanning for an
 * agent export would never think to look under *REST & HTTP*.
 */
const PARADIGM_FAMILY: Readonly<Record<string, string>> = {
  rest: 'rest',
  rpc: 'rpc',
  event: 'event',
  graph: 'data',
  data_schema: 'data',
  schema: 'data',
  agent: 'agent',
};

/**
 * The family a paradigm belongs to.
 *
 * @param paradigm The emitter descriptor's `paradigm`, in any case and with either spelling
 *   of the word separator (`data_schema` / `data-schema` / `Data Schema`).
 * @returns The matching family, or {@link OTHER_FAMILY} when the paradigm is unknown.
 */
export function familyForParadigm(paradigm: string | null | undefined): ExportTargetFamily {
  const normalized = (paradigm ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const key = PARADIGM_FAMILY[normalized];
  return EXPORT_TARGET_FAMILIES.find((family) => family.key === key) ?? OTHER_FAMILY;
}

/** One family together with the cards that fell into it. */
export interface ExportTargetFamilyGroup<T> extends ExportTargetFamily {
  /** The cards, in the order they arrived. */
  items: T[];
}

/**
 * Partition cards into families, preserving the incoming order inside each one.
 *
 * A family with no cards is not drawn — a workspace whose registry has no event emitters
 * should not be told there is an empty *Events* section.
 *
 * @param items The cards to group, already ordered by `orderTargetCards`.
 * @param paradigmOf Reads a card's paradigm — the caller keeps the card shape to itself.
 * @returns The non-empty groups, in {@link EXPORT_TARGET_FAMILIES} order with
 *   {@link OTHER_FAMILY} last.
 */
export function groupTargetsByFamily<T>(
  items: readonly T[],
  paradigmOf: (item: T) => string | null | undefined,
): ExportTargetFamilyGroup<T>[] {
  const order = [...EXPORT_TARGET_FAMILIES, OTHER_FAMILY];
  const groups = new Map<string, ExportTargetFamilyGroup<T>>(
    order.map((family) => [family.key, { ...family, items: [] }]),
  );
  for (const item of items) {
    groups.get(familyForParadigm(paradigmOf(item)).key)?.items.push(item);
  }
  return order
    .map((family) => groups.get(family.key)!)
    .filter((group) => group.items.length > 0);
}
