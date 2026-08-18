/**
 * Every presentation rule the primitive-detail screen makes (HIVE-6.6, #5317).
 *
 * Authority: `docs/mockups/build/primitive-detail.html`, whose **Notes → Keeps (1:1)** list is
 * this ticket's acceptance criteria.
 *
 * `../../../../ade/dashboard/primitives/primitiveDetailModel.ts` (#3468) already owns the
 * *derivations* — the namespace an `$id` asserts, the base chain, the usage counters, the
 * example instance. This module owns the layer above them: the badges the header draws, the
 * words a verdict uses, the rows the metadata aside lists, the tone a status takes. Both are
 * pure and React-free, so `tests/primitive-detail-view.test.ts` can hold them without
 * rendering anything.
 *
 * What lives here is what used to be spelled twice, or spelled in a place no theme could
 * reach:
 *
 *  - the **scope pill** was written three times over — in the header, in the metadata aside and
 *    in the dependents table — each with its own palette string, which is how one `is_system`
 *    flag came to draw a teal badge in one place and a green one 40 lines later;
 *  - the **verdict wording** and the **findings count** were each built inline in two branches
 *    of the same component, so "1 problems found" was one typo away at all times;
 *  - the **status tone** of a `$ref` edge was four Tailwind palette strings chosen in
 *    TypeScript. It resolves through {@link refStatusTone} now, the same function the resolver
 *    panel uses, so a resolved edge is the same green on both screens.
 */

import {
  refStatusTone,
  statusLabel,
  type RefStatus,
} from '@/app/ade/dashboard/primitives/primitivesResolverModel';
import type { StatusTone } from '@/app/components/ui/statusVocabulary';
import {
  scopeLabel,
  type DependentRef,
  type RefEdge,
  type BaseChainNode,
  type UsageSummary,
} from '@/app/ade/dashboard/primitives/primitiveDetailModel';
import {
  arrayLength,
  childPointer,
  coerceScalar,
  extraKeyIssue,
  extraNamesAt,
  isIncluded,
  itemPointer,
  type TestField,
  type TestFormState,
} from '@/app/ade/dashboard/primitives/primitiveTestForm';

/**
 * One registry type, as `GET /api/primitives/{id}` returns it.
 *
 * Declared here rather than in the client so every card on the screen reads one shape; the
 * fields beyond the required four are all optional because older rows (and older API builds)
 * legitimately omit them — see `refs` / `dependents`, which only arrived with #3477.
 */
export interface PrimitiveDetail {
  id: string;
  name: string;
  description: string | null;
  category: string;
  schema: Record<string, unknown>;
  is_system: boolean;
  is_public?: boolean;
  namespace?: string | null;
  schema_id?: string | null;
  base_uri?: string | null;
  draft?: string;
  source?: string;
  refs?: RefEdge[];
  dependents?: DependentRef[];
  usage_count: number;
  tags?: string[];
  created_at?: string | null;
}

/** The JSON Schema dialect a type is read under when the row does not name one. */
export const DEFAULT_DRAFT = '2020-12';

// ---------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------

/** One badge beside the page title. */
export interface DetailBadge {
  /** Stable key, and the `data-testid` suffix. */
  id: 'scope' | 'category' | 'draft' | 'immutable';
  /** The badge's text. */
  label: string;
  /** Its tone in the shared vocabulary. */
  tone: StatusTone;
  /** Draw the text monospaced — a dialect string and a JSON type are identifiers. */
  mono?: boolean;
}

/**
 * The badges the header draws beside the type's name.
 *
 * Scope, JSON type and dialect always; the immutability lock only for a system type, which is
 * the *visible* half of the acceptance criterion "system types show the immutable badge and
 * disabled edit with its reason" — {@link editAffordance} is the other half.
 *
 * @param primitive The type on screen.
 * @returns The badges, in the mockup's order.
 */
export function headerBadges(
  primitive: Pick<PrimitiveDetail, 'is_system' | 'category' | 'draft'>
): DetailBadge[] {
  const badges: DetailBadge[] = [
    {
      id: 'scope',
      label: scopeLabel(primitive.is_system),
      tone: primitive.is_system ? 'accent' : 'ok',
    },
    { id: 'category', label: primitive.category, tone: 'outline', mono: true },
    {
      id: 'draft',
      label: `draft ${primitive.draft ?? DEFAULT_DRAFT}`,
      tone: 'accent',
      mono: true,
    },
  ];

  if (primitive.is_system) {
    badges.push({ id: 'immutable', label: 'immutable (core)', tone: 'warn' });
  }

  return badges;
}

/** Whether the Edit action opens the editor, and what it says when it does not. */
export interface EditAffordance {
  /** `true` for a system type, which no tenant may edit. */
  disabled: boolean;
  /** The tooltip — the reason, when disabled; where it goes, when not. */
  title: string;
  /** Where Edit leads, or `null` when it leads nowhere. */
  href: string | null;
}

/** The reason a system type refuses to be edited, worded once. */
export const SYSTEM_IMMUTABLE_REASON = 'System primitives are immutable and cannot be edited';

/**
 * The header's Edit action.
 *
 * A tenant type opens the registry's own editor, which is where editing actually happens; the
 * pre-Hive page linked to `?edit=<id>`, a query the registry screen never read — the same dead
 * deep-link HIVE-6.5 fixed on the other side. The registry reads `?edit=` now
 * (`viewFromFocusParam`'s sibling in `primitivesModel`), so the link is honoured.
 *
 * @param primitive The type on screen.
 * @returns Whether Edit acts, its tooltip and its destination.
 */
export function editAffordance(primitive: Pick<PrimitiveDetail, 'id' | 'is_system'>): EditAffordance {
  if (primitive.is_system) {
    return { disabled: true, title: SYSTEM_IMMUTABLE_REASON, href: null };
  }
  return {
    disabled: false,
    title: 'Edit this type in the registry editor',
    href: `/ade/dashboard/primitives?edit=${primitive.id}`,
  };
}

/** Why Deprecate is inert, worded once. Lifecycle arrives with version roots. */
export const DEPRECATE_REASON =
  'Deprecation lifecycle (sunset dates) arrives with version roots — see #3482';

/**
 * The breadcrumb above the title.
 *
 * The last step is the namespace path rather than the type's name: the name is the `h1`
 * directly under it, and a trail whose last step repeats the heading tells the reader nothing.
 *
 * @param namespacePath The type's effective namespace, when it has one.
 * @returns The trail, outermost step first.
 */
export function detailBreadcrumb(namespacePath: string | null): { label: string; href?: string }[] {
  const trail: { label: string; href?: string }[] = [
    { label: 'Home', href: '/ade/dashboard' },
    { label: 'Build' },
    { label: 'Primitives & types', href: '/ade/dashboard/primitives' },
  ];
  if (namespacePath) trail.push({ label: namespacePath });
  return trail;
}

// ---------------------------------------------------------------------------------------
// The schema pane
// ---------------------------------------------------------------------------------------

/**
 * Height bounds for the JSON Schema pane, in `rem`.
 *
 * Monaco needs a definite viewport, so the pane is sized from the document itself: a two-line
 * primitive gets a short pane instead of a mostly-empty one, and a sprawling object schema
 * stops growing here and scrolls inside its own box rather than pushing the rest of the page
 * down.
 *
 * The unit is the point. Monaco's *type* is a documented pixel exemption
 * (`ui/code/editorTypography.ts`) because the editor measures glyphs itself; the *box* is not,
 * and stating it in `rem` is what makes the pane follow the reader's font-scale preference —
 * one of this ticket's acceptance criteria. The mockup froze it at 360 px.
 */
const SCHEMA_PANE_MIN_REM = 12.5;
const SCHEMA_PANE_MAX_REM = 35;
/** Monaco's line box at {@link CODE_EDITOR_FONT_SIZE}, expressed at the default root size. */
const SCHEMA_PANE_LINE_REM = 1.1875;
/** The editor's own top and bottom padding, likewise. */
const SCHEMA_PANE_PADDING_REM = 1.75;

/**
 * Size the schema pane to its content, clamped to the bounds above.
 *
 * @param json The pretty-printed schema the pane will hold.
 * @returns A CSS `rem` length, ready for the viewer's `height` prop.
 */
export function schemaPaneHeight(json: string): string {
  const lines = json.length === 0 ? 1 : json.split('\n').length;
  const natural = lines * SCHEMA_PANE_LINE_REM + SCHEMA_PANE_PADDING_REM;
  const clamped = Math.min(SCHEMA_PANE_MAX_REM, Math.max(SCHEMA_PANE_MIN_REM, natural));
  // Two decimals: the value is a multiple of 1.1875rem, which does not always terminate short.
  return `${Number(clamped.toFixed(2))}rem`;
}

/** How long the Copy button holds its acknowledgement before falling back to `Copy`. */
export const COPY_ACK_MS = 1500;

/** What the schema card's Copy button says and looks like right now. */
export interface CopyButtonState {
  /** The visible label, which is also the accessible name. */
  label: string;
  /** The tooltip — the longer sentence the label has no room for. */
  title: string;
  /** `true` while the acknowledgement is showing, so the button can swap its glyph. */
  acknowledged: boolean;
}

/**
 * The Copy button's three states.
 *
 * A failed clipboard write says so rather than flashing "Copied" for a write that never
 * landed — the case an insecure context or a denied permission produces.
 *
 * @param copied Whether the last write succeeded.
 * @param failed Whether it threw.
 * @returns The label, the tooltip and whether an acknowledgement is showing.
 */
export function copyButtonState(copied: boolean, failed: boolean): CopyButtonState {
  if (copied) {
    return { label: 'Copied', title: 'The JSON Schema is on the clipboard', acknowledged: true };
  }
  if (failed) {
    return { label: 'Copy failed', title: 'Could not write to the clipboard', acknowledged: true };
  }
  return { label: 'Copy', title: 'Copy the JSON Schema to the clipboard', acknowledged: false };
}

// ---------------------------------------------------------------------------------------
// Reference resolution and dependents
// ---------------------------------------------------------------------------------------

/** The three statuses the resolver stores, as they arrive on a stored edge. */
const REF_STATUSES: readonly string[] = ['resolved', 'unresolved', 'circular'];

/**
 * The tone and label a stored edge's status takes.
 *
 * The stored column is a free string, so an edge from an older build (or one this UI has not
 * heard of) has to render as *something*: it keeps its own text and takes the neutral tone
 * rather than being coerced into one of the three and mis-coloured.
 *
 * @param status The edge's `status` column.
 * @returns Its tone and the vocabulary's label for it.
 */
export function refEdgeStatus(status?: string | null): { tone: StatusTone; label: string } {
  const raw = (status ?? '').trim();
  if (!REF_STATUSES.includes(raw)) {
    return { tone: 'neutral', label: raw || 'unknown' };
  }
  return { tone: refStatusTone(raw as RefStatus), label: statusLabel(raw as RefStatus) };
}

/** What the reference table says when the type carries no relative `$ref`. */
export const NO_REFS_TITLE = 'No relative $ref values';
export const NO_REFS_DESCRIPTION = 'This type resolves to a flat schema.';

/**
 * The reference table's foot: the base every relative `$ref` is resolved against.
 *
 * @param baseUri The type's `base_uri`, when it has one.
 * @returns The sentence, or `null` when there is no base to name.
 */
export function refsFootLabel(baseUri?: string | null): string | null {
  return baseUri ? `Base: ${baseUri}` : null;
}

/** How a dependent type is named in its row. */
export function dependentLabel(dep: DependentRef): string {
  if (dep.namespace && dep.name) return `${dep.namespace}/${dep.name}`;
  return dep.name ?? dep.schema_id ?? '—';
}

/**
 * A dependent's scope pill.
 *
 * The one place the two scopes were spelled differently from the header's: this returns the
 * same words {@link scopeLabel} does for a system type, and appends the tenant slug when the
 * reverse index carried one.
 *
 * @param dep The dependent row.
 * @returns Its label and tone.
 */
export function dependentScope(dep: DependentRef): { label: string; tone: StatusTone } {
  if (dep.scope === 'system') {
    return { label: scopeLabel(true), tone: 'accent' };
  }
  return {
    label: dep.tenant_label ? `Tenant · ${dep.tenant_label}` : scopeLabel(false),
    tone: 'violet',
  };
}

/** What the dependents table says when nothing references this type. */
export const NO_DEPENDENTS_TITLE = 'No type in view references this one';
export const NO_DEPENDENTS_DESCRIPTION = 'A $ref from another type lists it here.';

/**
 * The dependents table's foot.
 *
 * @param count How many dependent rows are listed.
 * @returns `"3 dependents"`, singular when there is one.
 */
export function dependentsFootLabel(count: number): string {
  return `${count} ${count === 1 ? 'dependent' : 'dependents'}`;
}

/** How the generated example was chosen, stated for the reader who wonders. */
export const EXAMPLE_PROVENANCE =
  'generated: examples[0] → default → const → enum[0] → by type · depth-bounded';

// ---------------------------------------------------------------------------------------
// The metadata aside
// ---------------------------------------------------------------------------------------

/** How one metadata row draws its value. */
export type MetadataRowKind =
  /** A printed string. */
  | 'text'
  /** A `Badge` in the scope's tone. */
  | 'scope'
  /** The words plus a lock or a pencil. */
  | 'mutability';

/** One row of the metadata aside. */
export interface MetadataRow {
  /** Stable key, and the `data-testid` suffix. */
  id: 'id' | 'scope' | 'namespace' | 'version-root' | 'owner' | 'source' | 'created' | 'mutability';
  /** The `dt`. */
  label: string;
  /** How the `dd` is drawn. */
  kind: MetadataRowKind;
  /** The words. Already a display string — `'—'` when the type carries nothing. */
  value: string;
  /**
   * Monospace the value.
   *
   * Set for the four rows that are identifiers — an `$id`, a namespace path, a version root, an
   * owning slug — and not for the three that are prose or a date read as one.
   */
  mono?: boolean;
}

/** An empty cell, so every reading of "nothing here" is the same character. */
export const EMPTY_VALUE = '—';

/**
 * A creation timestamp as a date.
 *
 * ISO, not a locale format: the row sits beside an `$id` and a namespace path, and a date in
 * that company is an identifier rather than prose. An unparseable value degrades to
 * {@link EMPTY_VALUE} rather than to `Invalid Date`.
 *
 * @param iso The stored timestamp.
 * @returns `YYYY-MM-DD`, or {@link EMPTY_VALUE}.
 */
export function formatCreated(iso?: string | null): string {
  if (!iso) return EMPTY_VALUE;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE;
  return date.toISOString().slice(0, 10);
}

/** What the aside says about whether this type can be changed. */
export interface Mutability {
  /** The words — `"immutable · core"` or `"editable · tenant"`. */
  label: string;
  /** `true` for a system type, which draws the lock. */
  locked: boolean;
}

/**
 * The mutability row.
 *
 * @param isSystem Whether the type is system-core.
 * @returns Its label and whether to draw the lock.
 */
export function mutability(isSystem: boolean): Mutability {
  return isSystem
    ? { label: 'immutable · core', locked: true }
    : { label: 'editable · tenant', locked: false };
}

/**
 * The metadata aside's rows, in the mockup's order.
 *
 * All eight of them, scope and mutability included, even though those two are *drawn* rather than
 * printed — a badge and a lock. Order is the reason: the mockup puts Scope second, between the
 * `$id` and the namespace, and a list that held only the printed rows would leave the component
 * to append the other two at the end, which is where they ended up and read wrongly. The `kind`
 * says how each `dd` is drawn; the order says where it goes, once.
 *
 * @param fields The derived identity of the type on screen.
 * @returns The rows, every value already a display string.
 */
export function metadataRows(fields: {
  isSystem: boolean;
  schemaId?: string | null;
  namespace: string | null;
  versionRoot: string | null;
  owner: string;
  source?: string;
  createdAt?: string | null;
}): MetadataRow[] {
  return [
    { id: 'id', label: '$id', kind: 'text', value: fields.schemaId || EMPTY_VALUE, mono: true },
    { id: 'scope', label: 'Scope', kind: 'scope', value: scopeLabel(fields.isSystem) },
    {
      id: 'namespace',
      label: 'Namespace',
      kind: 'text',
      value: fields.namespace || EMPTY_VALUE,
      mono: true,
    },
    {
      id: 'version-root',
      label: 'Version root',
      kind: 'text',
      value: fields.versionRoot || EMPTY_VALUE,
      mono: true,
    },
    { id: 'owner', label: 'Owner', kind: 'text', value: fields.owner, mono: true },
    { id: 'source', label: 'Source', kind: 'text', value: fields.source || 'human' },
    { id: 'created', label: 'Created', kind: 'text', value: formatCreated(fields.createdAt) },
    {
      id: 'mutability',
      label: 'Mutability',
      kind: 'mutability',
      value: mutability(fields.isSystem).label,
    },
  ];
}

/** One tile of the "Used in" strip. */
export interface UsageTile {
  id: 'dependent-types' | 'properties' | 'tenants';
  label: string;
  value: number;
}

/**
 * The three "Used in" counters.
 *
 * Straight from {@link UsageSummary}, which is where the de-duplication lives (#3477 sends one
 * dependent entry per referencing edge, so a type that references this one twice is one
 * dependent type). This only names them.
 *
 * @param usage The summarised counters.
 * @returns The tiles, in the mockup's order.
 */
export function usageTiles(usage: UsageSummary): UsageTile[] {
  return [
    { id: 'dependent-types', label: 'Dependent types', value: usage.dependentTypes },
    { id: 'properties', label: 'Properties', value: usage.properties },
    { id: 'tenants', label: 'Tenants', value: usage.tenants },
  ];
}

// ---------------------------------------------------------------------------------------
// The base chain
// ---------------------------------------------------------------------------------------

/** What one step of the base chain is: this type, a resolved hop, or a dead one. */
export type ChainStepState = 'self' | 'resolved' | 'unresolved';

/**
 * The state of one chain step.
 *
 * A tone rather than a class, for the reason HIVE-6.5 moved `statusBadgeClass` out of
 * TypeScript: a colour chosen here is a colour no theme can reach.
 *
 * @param node The chain node.
 * @returns Which of the three states it is in.
 */
export function chainStepState(node: Pick<BaseChainNode, 'kind' | 'status'>): ChainStepState {
  if (node.kind === 'self') return 'self';
  return node.status === 'unresolved' ? 'unresolved' : 'resolved';
}

/**
 * The quiet line under one chain step.
 *
 * The head node states what the type *is*; a hop states where it goes, and says the word
 * `unresolved` when it goes nowhere — the state has to survive a reader who cannot see the
 * amber rail beside it.
 *
 * @param node The chain node.
 * @param category The type's own JSON type, for the head node's line.
 * @returns The sentence.
 */
export function chainStepMeta(
  node: Pick<BaseChainNode, 'kind' | 'status' | 'target'>,
  category: string
): string {
  if (node.kind === 'self') return `${category} · this type`;
  if (!node.target) return 'unresolved';
  return `→ ${node.target}${node.status === 'unresolved' ? ' · unresolved' : ''}`;
}

// ---------------------------------------------------------------------------------------
// The test form's verdict
// ---------------------------------------------------------------------------------------

/** What the validator concluded, as the test form's compiled validator reports it. */
export type TestStatus = 'valid' | 'invalid' | 'unavailable';

/** The verdict bar's tone and words. */
export interface Verdict {
  /** The tone the bar takes. */
  tone: 'ok' | 'warn' | 'danger';
  /** The sentence it prints. */
  message: string;
  /** The `data-status` the bar carries, which is what the suites assert on. */
  status: TestStatus;
}

/**
 * The always-current verdict.
 *
 * Coercion problems outrank Ajv: a box holding `abc` where a number belongs means the instance
 * is not well-formed yet, so there is nothing meaningful to have validated. A schema that would
 * not compile is amber rather than red — nothing the reader typed is wrong.
 *
 * This is the wording the pre-Hive card produced, moved out of the component unchanged. The
 * ticket's first acceptance criterion is that the verdicts do not change, and a function is how
 * that gets asserted without rendering.
 *
 * @param result The validator's status, its findings and any compile error.
 * @param hasCoercionError Whether any box holds a value that cannot be read at all.
 * @returns The bar's tone, sentence and `data-status`.
 */
export function verdict(
  result: { status: TestStatus; findingCount: number; schemaError?: string },
  hasCoercionError: boolean
): Verdict {
  if (result.status === 'unavailable') {
    return {
      tone: 'warn',
      message: `Schema could not be compiled — ${result.schemaError ?? 'unknown error'}`,
      status: 'unavailable',
    };
  }
  if (hasCoercionError) {
    return { tone: 'danger', message: 'Some inputs are not valid values yet', status: 'invalid' };
  }
  if (result.status === 'invalid') {
    return { tone: 'danger', message: `${problemCount(result.findingCount)} found`, status: 'invalid' };
  }
  return { tone: 'ok', message: 'Valid against this schema', status: 'valid' };
}

/**
 * `"1 problem"` / `"2 problems"`, so no branch of the card can print `1 problems`.
 *
 * @param count How many findings there are.
 * @returns The counted noun.
 */
export function problemCount(count: number): string {
  return `${count} ${count === 1 ? 'problem' : 'problems'}`;
}

/**
 * The loose-validation caveat.
 *
 * The one sentence the acceptance criteria name explicitly: a `$ref` the browser cannot resolve
 * means the constraints behind it were *not* checked, and a verdict that does not say so is a
 * green tick the reader would be wrong to trust.
 *
 * @param unresolvedRefs The `$ref` values the compile could not resolve.
 * @returns The sentence, or `null` when everything resolved.
 */
export function looseValidationNote(unresolvedRefs: readonly string[]): string | null {
  if (unresolvedRefs.length === 0) return null;
  return `Validated loosely: ${unresolvedRefs.join(', ')} could not be resolved in the browser, so those constraints are not checked here.`;
}

/** The card's own subtitle — there is no button to press, and it says so. */
export const LIVE_VALIDATION_NOTE = 'Validated as you type — no need to press anything.';

/** What an empty object says in place of a form. */
export const EMPTY_OBJECT_NOTE =
  'This object declares no properties, so there is nothing to fill in.';

/** What an array with no `items` says in place of an element editor. */
export const NO_ITEM_SCHEMA_NOTE = 'This array does not declare an item schema.';

/** What a property that is switched off says in place of its editor. */
export const OMITTED_NOTE = 'Omitted from the instance.';

/**
 * The message for a dynamic-property row that cannot join the instance.
 *
 * @param issue Which problem the row has, from `extraKeyIssue`.
 * @param name The name typed into the row.
 * @returns The sentence to print in place of the row's editor.
 */
export function extraKeyMessage(issue: 'empty' | 'duplicate', name: string): string {
  return issue === 'empty'
    ? 'Name this property to include it in the instance.'
    : `"${name}" is already a property of this object — rename or remove this row.`;
}

/**
 * The live `pattern` verdict beside a regex-constrained box.
 *
 * @param matches `true`/`false` for a regex this browser ran, `null` for one it could not.
 * @returns The words after the regex.
 */
export function patternVerdictLabel(matches: boolean | null): string {
  if (matches === null) return 'is not a regex this browser can run';
  return matches ? 'matches' : 'does not match';
}

/** The `data-matches` attribute the pattern line carries, which the suites assert on. */
export function patternMatchAttribute(matches: boolean | null | undefined): string {
  return matches === null ? 'invalid-pattern' : String(matches);
}

/** What the loading page says while the type is on its way. */
export const LOADING_MESSAGE = 'Loading type detail…';

// ---------------------------------------------------------------------------------------
// The test form's field tree
// ---------------------------------------------------------------------------------------

/**
 * The human type hint beside a property's name — `string · email`, `enum`, `$ref ../decimal`.
 *
 * @param field The projected field.
 * @returns The hint.
 */
export function describeFieldType(
  field: Pick<TestField, 'kind' | 'format' | 'unresolvedRef'>
): string {
  if (field.kind === 'enum') return 'enum';
  if (field.unresolvedRef) return `$ref ${field.unresolvedRef}`;
  return field.format ? `${field.kind} · ${field.format}` : field.kind;
}

/**
 * Whether a field is edited through a control of its own, and therefore whether its name can be
 * a `<label for>`.
 *
 * An object or an array is a *group* of controls: a label pointing at one would either name the
 * wrong box or, as the pre-Hive form did, point at an id nothing carries.
 *
 * @param field The projected field.
 * @returns `true` for a scalar, `false` for a container.
 */
export function isScalarField(field: Pick<TestField, 'kind'>): boolean {
  return field.kind !== 'object' && field.kind !== 'array';
}

/**
 * Walk the included form tree, collecting per-field coercion problems keyed by pointer.
 *
 * These are the problems that never reach Ajv because the instance cannot be built at all —
 * `abc` in a number box, `{` in a raw-JSON box. They outrank every schema finding, which is why
 * {@link verdict} checks them first.
 *
 * Only what actually reaches the instance is walked: a property switched off, and a
 * dynamic-property row whose name is empty or duplicated, are not part of the document and
 * cannot be wrong in it.
 *
 * @param field The root of the rendered tree.
 * @param state The form state.
 * @param pointer The root's own pointer (`''` for the whole instance).
 * @returns Pointer → message, for every box holding a value that cannot be read.
 */
export function collectCoercionErrors(
  field: TestField,
  state: TestFormState,
  pointer = ''
): Map<string, string> {
  const errors = new Map<string, string>();

  const walk = (node: TestField, nodePointer: string): void => {
    if (node.kind === 'object') {
      for (const child of node.children ?? []) {
        const childPtr = childPointer(nodePointer, child.key);
        if (isIncluded(state, childPtr, child)) walk(child, childPtr);
      }
      // Dynamic entries that reach the instance are checked like declared properties.
      if (node.additional) {
        const names = extraNamesAt(state, nodePointer);
        names.forEach((name, index) => {
          if (extraKeyIssue(node, names, index) === null) {
            walk(node.additional as TestField, childPointer(nodePointer, name));
          }
        });
      }
      return;
    }
    if (node.kind === 'array') {
      if (!node.item) return;
      const count = arrayLength(state, nodePointer);
      for (let index = 0; index < count; index += 1) walk(node.item, itemPointer(nodePointer, index));
      return;
    }
    const { error } = coerceScalar(node, state.values[nodePointer] ?? '');
    if (error) errors.set(nodePointer, error);
  };

  walk(field, pointer);
  return errors;
}
