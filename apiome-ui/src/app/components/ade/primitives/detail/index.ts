/**
 * `/ade/dashboard/primitives/[id]`: one registry type, beyond the edit dialog (HIVE-6.6, #5317).
 *
 * The page is a main column of six cards beside an aside of three, over one `GET`.
 * `PrimitiveDetailClient` keeps the fetch and the two writes (Copy, Download); every surface it
 * draws is here, and every rule they share is in `primitiveDetailView.ts` so no two cards can
 * word the same state differently.
 *
 * @see `docs/mockups/build/primitive-detail.html` — the mockup, and its Keeps (1:1) list.
 */

export { default as PrimitiveSchemaCard } from './PrimitiveSchemaCard';
export { default as ReferenceResolutionCard } from './ReferenceResolutionCard';
export { default as ExampleInstanceCard } from './ExampleInstanceCard';
export { default as DependentsCard } from './DependentsCard';
export { default as PrimitiveMetadataCard } from './PrimitiveMetadataCard';
export { default as PrimitiveUsageCard } from './PrimitiveUsageCard';
export { default as BaseChainCard } from './BaseChainCard';
export { PrimitiveTestForm } from './PrimitiveTestForm';

export type { PrimitiveSchemaCardProps } from './PrimitiveSchemaCard';
export type { ReferenceResolutionCardProps } from './ReferenceResolutionCard';
export type { ExampleInstanceCardProps } from './ExampleInstanceCard';
export type { DependentsCardProps } from './DependentsCard';
export type { PrimitiveMetadataCardProps } from './PrimitiveMetadataCard';
export type { PrimitiveUsageCardProps } from './PrimitiveUsageCard';
export type { BaseChainCardProps } from './BaseChainCard';
export type { PrimitiveTestFormProps } from './PrimitiveTestForm';
export type { FieldContext } from './testFormFields';

export * from './primitiveDetailView';
