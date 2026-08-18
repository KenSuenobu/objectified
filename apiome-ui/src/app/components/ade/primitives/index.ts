/**
 * `/ade/dashboard/primitives`: the JSON-Schema type registry (HIVE-6.5, #5316).
 *
 * The screen is four panes over one registry — the Registry list, the namespaces that scope it,
 * the `$ref` resolver that binds it together, and the settings that govern all three. This
 * barrel is what `PrimitivesManagementClient` composes them from; `primitivesModel.ts` holds
 * every rule they share so no two panes can word the same state differently.
 *
 * @see `docs/mockups/build/primitives.html` — the mockup, and its Keeps (1:1) list.
 */

export { default as PrimitivesKpiStrip } from './PrimitivesKpiStrip';
export { default as TypeCollectionsPanel } from './TypeCollectionsPanel';
export { default as RegistryRail } from './RegistryRail';
export { default as PrimitiveTypesTable } from './PrimitiveTypesTable';
export { default as NamespacesPanel } from './NamespacesPanel';
export { default as NamespaceEditorDialog } from './NamespaceEditorDialog';
export { default as ResolverPanel } from './ResolverPanel';
export { default as RegistrySettingsPanel } from './RegistrySettingsPanel';

export type { NamespaceSelectOptions, TypeCollectionsPanelProps } from './TypeCollectionsPanel';
export type { PrimitiveRow, PrimitiveTypesTableProps } from './PrimitiveTypesTable';
export type { PrimitivesKpiStripProps } from './PrimitivesKpiStrip';
export type { RegistryRailProps } from './RegistryRail';
export type { NamespacesPanelProps } from './NamespacesPanel';
export type { NamespaceEditorDialogProps } from './NamespaceEditorDialog';
export type { ResolverPanelProps } from './ResolverPanel';
export type { RegistrySettingsPanelProps } from './RegistrySettingsPanel';

export * from './primitivesModel';
export { ALL_CATEGORIES } from './PrimitiveTypesTable';
