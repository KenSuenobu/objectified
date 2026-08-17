// Radix UI based components
export * from './Dialog';
export * from './Label';
export * from './Input';
export * from './Button';
export * from './Alert';
export * from './Card';
export * from './Skeleton';
export * from './Badge';
export * from './Checkbox';
export * from './Textarea';
export * from './Switch';
export * from './Tooltip';
export * from './Tabs';
export * from './tabStyles';
export * from './Select';
export * from './Collapsible';
export * from './RadioGroup';
export * from './FormField';
export * from './Spinner';

// The feedback set (HIVE-2.5, #5284): the four states every screen is in when it has no
// content to draw — nothing yet, still coming, it broke, or you cannot see it from here.
// `EmptyState` carries the honeycomb art, `GatedState` is its lock preset, `ErrorState` and
// `ErrorBanner` are the two spellings of a failure, `LoadingState` is the live region, and
// the `Skeleton*` presets are the shapes it holds space with.
export * from './LoadingState';
export * from './EmptyState';
export * from './ErrorState';

// New Hive primitives (HIVE-2.2, #5281): the four patterns the mockups repeat that had no
// production equivalent — the view switch, the right side-sheet, the identity mark and the
// shortcut chip.
export * from './Segmented';
export * from './Drawer';
export * from './Avatar';
export * from './Kbd';

// The progress row of a multi-step flow (HIVE-4.4, #5298) — ten mockups draw one, and the
// first-tenant onboarding wizard is the first surface in production to need it.
export * from './Stepper';

// The list surface (HIVE-2.3, #5282): one composable table — toolbar, sticky sortable
// header, selection with a bulk bar, foot with count and pager, and the loading / empty /
// error states — plus the codec that keeps its filters, sort and page in the address bar.
// Retires `components/ade/dashboard/dashboardScreenClasses.ts` as each page epic migrates.
export * from './DataTable';
export * from './dataTableUrlState';
export * from './useDataTableUrlState';

// The status vocabulary (HIVE-2.4, #5283): one mapping from the app's own enum strings to a
// tone, plus the A–F quality bands. `Badge`, the MCP health/freshness/grade surfaces and the
// catalog grade chip all resolve through it, so a state is one colour everywhere.
export * from './statusVocabulary';

// The HTTP verb chip (HIVE-2.4, #5283) — a fixed hue per method, unlike a status tone, because
// a verb's colour is an identity rather than a state.
export * from './MethodChip';

// Shared MCP catalog primitives (V2-MCP-24.7)
export * from './mcp';

// Design-language sizes (HIVE-1.6, #5279): the §3.5 icon vocabulary, and the type sizes
// for text drawn inside an SVG coordinate system. Both are constants rather than tokens
// because their consumers are props, not stylesheets.
export * from './iconSizes';
export * from './svgTypography';
